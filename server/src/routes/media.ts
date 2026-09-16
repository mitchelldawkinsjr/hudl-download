// Media serving for review (Phase 5). Serves a play angle's clip + thumbnail
// from MEDIA_ROOT, behind auth + team authorization. Paths are not enumerable
// (you must know the play + angle IDs). Phase 7 hardens this with signed/
// short-lived URLs; for MVP the auth+team check is the gate.
//
//   GET /plays/:id/angles/:angleId/clip       → video/mp4 (range-aware)
//   GET /plays/:id/angles/:angleId/thumbnail   → image/webp
import { Router, type Request, type Response } from 'express';
import { resolve as resolvePath } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { query } from '../db/client.js';
import { asyncHandler, badRequest, notFound, requireUuid } from '../middleware/error.js';
import { requireAuth, requireTeam, type AuthedRequest } from '../middleware/auth.js';
import { env } from '../config/env.js';

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

function angleFileRoute(kind: 'clip' | 'thumbnail') {
  return asyncHandler(async (req, res) => {
    requireUuid(req.params.id, 'play');
    requireUuid(req.params.angleId, 'angle');
    const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'media.team' });
    if (!rows[0]) throw notFound('play');
    const ar = req as AuthedRequest;
    if (ar.role !== 'admin' && !ar.teamIds.includes(rows[0].team_id)) throw notFound('play');
    const a = await query('select clip_uri, thumbnail_uri, status from play_angles where id = $1 and play_id = $2', [req.params.angleId, req.params.id], { tag: 'media.angle' });
    if (!a.rows[0]) throw notFound('angle');
    const rel = kind === 'clip' ? a.rows[0].clip_uri : a.rows[0].thumbnail_uri;
    if (!rel) throw notFound('media');
    const ct = kind === 'clip' ? 'video/mp4' : 'image/webp';
    await serveFile(rel, ct, req, res);
  });
}

mediaRouter.get('/plays/:id/angles/:angleId/clip', requireAuth, requireTeam(async (req) => {
  requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
  return rows[0]?.team_id ?? null;
}), angleFileRoute('clip'));

mediaRouter.get('/plays/:id/angles/:angleId/thumbnail', requireAuth, requireTeam(async (req) => {
  requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
  return rows[0]?.team_id ?? null;
}), angleFileRoute('thumbnail'));

