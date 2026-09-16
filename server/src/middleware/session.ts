// Session middleware using cookie-session. HttpOnly, Secure in production,
// SameSite=Lax. Signed with SESSION_SECRET. The session holds { userId,
// role, teamIds } once authenticated. cookie-session's own types already
// augment req.session as a CookieSessionObject (index-signature record); we
// read/write the typed fields via the SessionData cast below rather than
// re-augmenting express (which would conflict with cookie-session's types).
import session from 'cookie-session';
import type { Application } from 'express';
import { env, isProd } from '../config/env.js';

export interface SessionData {
  userId?: string;
  role?: string;
  teamIds?: string[];
}

/** Typed view of the cookie-session object. */
export function getSessionData(req: { session?: unknown }): SessionData | null {
  const s = req.session as Record<string, unknown> | null | undefined;
  return (s as SessionData) ?? null;
}

export function installSession(app: Application) {
  app.use(
    session({
      name: 'filmroom_session',
      keys: [env.SESSION_SECRET],
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      // 12 hours — long enough for a game session, short enough to limit
      // exposure of a stolen cookie.
      maxAge: 12 * 60 * 60 * 1000,
    })
  );
}
