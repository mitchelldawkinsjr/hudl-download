// Telestrations on server clips (Phase 5). Per game/play/angle/author; the
// review UI draws on a server clip and persists strokes at a logical time.
// API-backed optimistic: POST creates, PATCH updates with version conflict
// detection, DELETE removes. Local-film notes are unchanged (client-only).
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, notFound, conflict, requireUuid } from '../middleware/error.js';
import { requireAuth, requireRole, requireTeam, type AuthedRequest } from '../middleware/auth.js';

export const telestrationsRouter = Router();

const createSchema = z.object({
  angleId: z.string().uuid().nullable(),
  timeMs: z.number().int().min(0),
  strokes: z.array(z.any()).default([]),
});

const patchSchema = z.object({
  strokes: z.array(z.any()).optional(),
  version: z.number().int().positive(),
});

function rowToJson(r: Record<string, unknown>) {
  return {
    id: r.id, playId: r.play_id, angleId: r.angle_id, authorId: r.author_id,
    timeMs: r.time_ms, strokes: typeof r.strokes_json === 'string' ? JSON.parse(r.strokes_json) : r.strokes_json,
    version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

telestrationsRouter.get(
  '/plays/:id/telestrations',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const angleId = (req.query.angleId as string) || null;
    let sql = `select * from telestrations where play_id = $1`;
    const params: unknown[] = [req.params.id];
    if (angleId) { sql += ` and angle_id = $2`; params.push(angleId); }
    sql += ` order by time_ms asc`;
    const { rows } = await query(sql, params, { tag: 'telestrations.list' });
    res.json({ data: rows.map(rowToJson) });
  })
);

telestrationsRouter.post(
  '/plays/:id/telestrations',
  requireAuth,
  requireRole('admin', 'operator', 'reviewer'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const parsed = createSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    const { rows } = await query(
      `insert into telestrations (play_id, angle_id, author_id, time_ms, strokes_json)
       values ($1,$2,$3,$4,$5) returning *`,
      [req.params.id, parsed.angleId, ar.userId, parsed.timeMs, JSON.stringify(parsed.strokes)],
      { tag: 'telestrations.create' }
    );
    await audit({ actorId: ar.userId, action: 'telestration.create', entityType: 'play', entityId: req.params.id, requestId: res.locals.requestId });
    res.status(201).json({ data: rowToJson(rows[0]) });
  })
);

telestrationsRouter.patch(
  '/telestrations/:id',
  requireAuth,
  requireRole('admin', 'operator', 'reviewer'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'telestration'); const { rows } = await query('select team_id from telestrations t join plays p on p.id = t.play_id join games g on g.id = p.game_id where t.id = $1', [req.params.id], { tag: 'telestrations.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.parse(req.body ?? {});
    const { rows } = await query(
      `update telestrations set strokes_json = coalesce($2, strokes_json), version = version + 1
       where id = $1 and version = $3 returning *`,
      [req.params.id, JSON.stringify(parsed.strokes), parsed.version],
      { tag: 'telestrations.update' }
    );
    if (!rows[0]) {
      const exists = await query('select id from telestrations where id = $1', [req.params.id], { tag: 'telestrations.exists' });
      if (!exists.rows[0]) throw notFound('telestration');
      throw conflict('version mismatch; reload the telestration');
    }
    res.json({ data: rowToJson(rows[0]) });
  })
);

telestrationsRouter.delete(
  '/telestrations/:id',
  requireAuth,
  requireRole('admin', 'operator', 'reviewer'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'telestration'); const { rows } = await query('select team_id from telestrations t join plays p on p.id = t.play_id join games g on g.id = p.game_id where t.id = $1', [req.params.id], { tag: 'telestrations.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query('delete from telestrations where id = $1 returning id', [req.params.id], { tag: 'telestrations.delete' });
    if (rows[0]) await audit({ actorId: ar.userId, action: 'telestration.delete', entityType: 'telestration', entityId: req.params.id, requestId: res.locals.requestId });
    res.json({ data: { ok: true } });
  })
);
