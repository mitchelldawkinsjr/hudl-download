// Auth routes: login (HTTP-only Secure SameSite=Lax session cookie, generic
// invalid-credentials error), logout (idempotent), GET /me. Passwords hashed
// with Argon2id. Login rate-limiting is handled at the router level below.
import { Router } from 'express';
import { z } from 'zod';
import argon2 from '@node-rs/argon2';
import { query } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, badRequest, unauthorized } from '../middleware/error.js';
import { getSessionData } from '../middleware/session.js';
import { rateLimit } from '../middleware/rate-limit.js';

export const authRouter = Router();

// Login brute-force protection: 10 attempts per minute per IP. Applied before
// body parsing so a flood is rejected cheaply.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, scope: 'login' });

const loginSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(1).max(1024),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid credentials', parsed.error.flatten());
    }
    const { email, password } = parsed.data;

    const { rows } = await query(
      `select id, email, display_name, password_hash, role, disabled_at
       from users where email = $1`,
      [email],
      { tag: 'users.findByEmail' }
    );
    const user = rows[0];
    // Constant-ish failure path: even when the user is absent, run a dummy
    // argon2 verify against a precomputed hash to keep timing similar.
    const DUMMY_HASH =
      '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = user
      ? !user.disabled_at && user.password_hash
        ? await argon2.verify(user.password_hash, password)
        : false
      : (await argon2.verify(DUMMY_HASH, password), false);

    if (!user || !ok) {
      // Generic message — never reveal whether the email exists.
      await audit({ actorId: user?.id ?? null, action: 'auth.login_failed', entityType: 'user', entityId: user?.id ?? null, requestId: res.locals.requestId });
      throw unauthorized('invalid credentials');
    }

    const teamRes = await query(
      'select team_id from team_members where user_id = $1',
      [user.id],
      { tag: 'team_members.list' }
    );
    const teamIds = teamRes.rows.map((r) => r.team_id);

    const sess = req.session as Record<string, unknown>;
    sess.userId = user.id;
    sess.role = user.role;
    sess.teamIds = teamIds;
    // cookie-session writes the Set-Cookie header automatically when the
    // response is sent — no explicit save() call needed (and it has none).

    await audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, requestId: res.locals.requestId });
    res.json({ data: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, teamIds } });
  })
);

authRouter.post(
  '/logout',
  (req, res) => {
    const userId = getSessionData(req)?.userId;
    req.session = null as never;
    res.json({ data: { ok: true } });
    if (userId) audit({ actorId: userId, action: 'auth.logout', entityType: 'user', entityId: userId, requestId: res.locals.requestId });
  }
);

authRouter.get(
  '/me',
  asyncHandler(async (req, res, next) => {
    const s = getSessionData(req);
    if (!s?.userId) {
      next(unauthorized());
      return;
    }
    const { rows } = await query(
      `select u.id, u.email, u.display_name, u.role, u.disabled_at,
              coalesce(json_agg(tm.team_id) filter (where tm.team_id is not null), '[]') as team_ids
       from users u
       left join team_members tm on tm.user_id = u.id
       where u.id = $1
       group by u.id`,
      [s.userId],
      { tag: 'users.me' }
    );
    const user = rows[0];
    if (!user || user.disabled_at) {
      next(unauthorized());
      return;
    }
    res.json({
      data: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        teamIds: user.team_ids,
      },
    });
  })
);
