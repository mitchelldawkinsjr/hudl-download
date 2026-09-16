// Media serving for review (Phase 5). Serves a play angle's clip + thumbnail
// from MEDIA_ROOT. Two auth paths:
//   1. Session + team authorization (default, used by the review UI).
//   2. Signed short-lived token (?token=...) for share-out, verified by
//      security/signed-media (HMAC + expiry, scoped to play/angle/kind).
// Paths are not enumerable (you must know the play + angle IDs).
//
//   GET /plays/:id/angles/:angleId/clip       → video/mp4 (range-aware)
//   GET /plays/:id/angles/:angleId/thumbnail   → image/webp
//   POST /plays/:id/angles/:angleId/sign      → { token, expiresAt } (auth)
import { Router, type Request, type Response } from 'express';
import { resolve as resolvePath } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { query } from '../db/client.js';
import { asyncHandler, badRequest, notFound, requireUuid, unauthorized, forbidden } from '../middleware/error.js';
import { requireAuth, requireTeam } from '../middleware/auth.js';
import { getSessionData } from '../middleware/session.js';
import { env } from '../config/env.js';
import { signMedia, verifyMedia } from '../security/signed-media.js';

export const mediaRouter = Router();

function safeMediaPath(rel: string): string | null {
  // rel is like "games/<gameId>/plays/<playId>/<sourceKey>.mp4". Reject any
  // traversal attempts; only allow a relative path under MEDIA_ROOT.
  if (!rel || typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) return null;
  const base = resolvePath(env.MEDIA_ROOT);
  const full = resolvePath(base, rel);
  if (full !== base && !full.startsWith(base + '/')) return null;
  return full;
}

async function serveFile(rel: string, contentType: string, req: Request, res: Response) {
  const full = safeMediaPath(rel);
  if (!full) throw badRequest('invalid media path');
  let st;
  try { st = await stat(full); } catch { throw notFound('media'); }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(String(range));
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start > end || start < 0 || end >= st.size) throw badRequest('invalid range');
      res.status(206);
      res.set('content-range', `bytes ${start}-${end}/${st.size}`);
      res.set('accept-ranges', 'bytes');
      res.set('content-length', String(end - start + 1));
      res.set('content-type', contentType);
      createReadStream(full, { start, end }).pipe(res);
      return;
    }
  }
  res.set('content-type', contentType);
  res.set('content-length', String(st.size));
  res.set('accept-ranges', 'bytes');
  createReadStream(full).pipe(res);
}

// Authorization for media GETs. Two paths:
//   1. Signed token (?token=...) scoped to this play/angle/kind → allowed
//      without a session (share-out links).
//   2. Session + team authorization → 401 if no session, 403 if cross-team.
// A play that doesn't exist yields 404 (don't leak existence to a token
// holder with a wrong-scope token; that's a 401 on the token path).
async function mediaAuth(req: Request, kind: 'clip' | 'thumbnail') {
  requireUuid(req.params.id, 'play');
  requireUuid(req.params.angleId, 'angle');
  const token = req.query.token;
  if (typeof token === 'string') {
    const sig = verifyMedia(token);
    if (!sig || sig.playId !== req.params.id || sig.angleId !== req.params.angleId || sig.kind !== kind) {
      throw unauthorized('invalid or expired media token');
    }
    return;
  }
  const sess = getSessionData(req);
  if (!sess?.userId) throw unauthorized();
  const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'media.team' });
  if (!rows[0]) throw notFound('play');
  const teamIds = sess.teamIds || [];
  if (sess.role !== 'admin' && !teamIds.includes(rows[0].team_id)) throw forbidden();
}

function angleFileRoute(kind: 'clip' | 'thumbnail') {
  return asyncHandler(async (req, res) => {
    await mediaAuth(req, kind);
    const a = await query('select clip_uri, thumbnail_uri, status from play_angles where id = $1 and play_id = $2', [req.params.angleId, req.params.id], { tag: 'media.angle' });
    if (!a.rows[0]) throw notFound('angle');
    const rel = kind === 'clip' ? a.rows[0].clip_uri : a.rows[0].thumbnail_uri;
    if (!rel) throw notFound('media');
    const ct = kind === 'clip' ? 'video/mp4' : 'image/webp';
    await serveFile(rel, ct, req, res);
  });
}

mediaRouter.get('/plays/:id/angles/:angleId/clip', angleFileRoute('clip'));
mediaRouter.get('/plays/:id/angles/:angleId/thumbnail', angleFileRoute('thumbnail'));

// Mint a signed, short-lived token for sharing a clip/thumbnail. Requires a
// session + team authorization (only members can mint share links).
mediaRouter.post('/plays/:id/angles/:angleId/sign', requireAuth, requireTeam(async (req) => {
  requireUuid(req.params.id, 'play'); requireUuid(req.params.angleId, 'angle');
  const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
  return rows[0]?.team_id ?? null;
}), asyncHandler(async (req, res) => {
  const kind = (req.query.kind === 'thumbnail' ? 'thumbnail' : 'clip') as 'clip' | 'thumbnail';
  const ttl = Math.min(Math.max(Number(req.query.ttl) || 300, 60), 86400);
  const token = signMedia(req.params.id, req.params.angleId, kind, ttl);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  res.json({ data: { token, kind, expiresAt: new Date(exp * 1000).toISOString() } });
}));

