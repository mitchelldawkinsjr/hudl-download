// Games routes: create/list/get, start/end, get sources, assign + reorder
// sources. Team-scoped authorization.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, badRequest, notFound, forbidden, conflict, requireUuid } from '../middleware/error.js';
import { requireAuth, requireRole, requireTeam, type AuthedRequest } from '../middleware/auth.js';

export const gamesRouter = Router();

const createSchema = z.object({
  teamId: z.string().uuid(),
  opponent: z.string().min(1).max(200),
  venue: z.string().max(200).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  preRollMs: z.number().int().min(0).max(600000).optional(),
  postRollMs: z.number().int().min(0).max(600000).optional(),
});

function rowToJson(r: Record<string, unknown>) {
  return {
    id: r.id,
    teamId: r.team_id,
    opponent: r.opponent,
    venue: r.venue,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    nextPlayNumber: r.next_play_number,
    preRollMs: r.pre_roll_ms,
    postRollMs: r.post_roll_ms,
    createdBy: r.created_by,
  };
}

gamesRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const parsed = createSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    if (ar.role !== 'admin' && !ar.teamIds.includes(parsed.teamId)) {
      throw forbidden('not a member of this team');
    }
    const { rows } = await query(
      `insert into games (team_id, opponent, venue, scheduled_at, pre_roll_ms, post_roll_ms, created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [
        parsed.teamId, parsed.opponent, parsed.venue ?? null, parsed.scheduledAt ?? null,
        parsed.preRollMs ?? 18000, parsed.postRollMs ?? 3000, ar.userId,
      ],
      { tag: 'games.create' }
    );
    await audit({ actorId: ar.userId, action: 'game.create', entityType: 'game', entityId: rows[0].id, after: parsed, requestId: res.locals.requestId });
    res.status(201).json({ data: rowToJson(rows[0]) });
  })
);

gamesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const status = (req.query.status as string) || undefined;
    let sql = `select * from games`;
    const params: unknown[] = [];
    const where: string[] = [];
    if (ar.role !== 'admin') {
      where.push(`team_id = any($${params.length + 1}::uuid[])`);
      params.push(ar.teamIds);
    }
    if (status) {
      where.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (where.length) sql += ' where ' + where.join(' and ');
    sql += ' order by scheduled_at desc nulls last, created_at desc limit 100';
    const { rows } = await query(sql, params, { tag: 'games.list' });
    res.json({ data: rows.map(rowToJson) });
  })
);

gamesRouter.get(
  '/:id',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await query('select * from games where id = $1', [req.params.id], { tag: 'games.get' });
    if (!rows[0]) throw notFound('game');
    res.json({ data: rowToJson(rows[0]) });
  })
);

gamesRouter.post(
  '/:id/start',
  requireAuth,
  requireRole('admin', 'operator'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const result = await withTransaction(async (c) => {
      const r = await c.query('select * from games where id = $1 for update', [req.params.id]);
      const game = r.rows[0];
      if (!game) return null;
      if (game.status === 'live') return game; // idempotent
      if (game.status === 'ended' || game.status === 'archived') {
        throw conflict('game is not in a startable state');
      }
      // Verify at least one configured source (via the join table).
      const srcs = await c.query('select count(*)::int as n from game_sources where game_id = $1', [req.params.id]);
      if (srcs.rows[0].n < 1) throw badRequest('game has no configured sources');
      const upd = await c.query(
        `update games set status='live', started_at=coalesce(started_at, now()) where id=$1 returning *`,
        [req.params.id]
      );
      return upd.rows[0];
    });
    if (!result) throw notFound('game');
    await audit({ actorId: ar.userId, action: 'game.start', entityType: 'game', entityId: req.params.id, requestId: res.locals.requestId });
    res.json({ data: rowToJson(result) });
  })
);

gamesRouter.post(
  '/:id/end',
  requireAuth,
  requireRole('admin', 'operator'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query(
      `update games set status='ended', ended_at=coalesce(ended_at, now()) where id=$1 and status='live' returning *`,
      [req.params.id],
      { tag: 'games.end' }
    );
    if (rows[0]) {
      await audit({ actorId: ar.userId, action: 'game.end', entityType: 'game', entityId: req.params.id, requestId: res.locals.requestId });
    }
    res.json({ data: rows[0] ? rowToJson(rows[0]) : null });
  })
);

gamesRouter.get(
  '/:id/sources',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `select s.id, s.key, s.display_name, s.mediamtx_path, s.preview_protocol,
              s.playback_url_override, gs.sort_order, s.active
       from game_sources gs
       join sources s on s.id = gs.source_id
       where gs.game_id = $1
       order by gs.sort_order, s.display_name`,
      [req.params.id],
      { tag: 'games.sources' }
    );
    res.json({ data: rows.map((r) => ({
      id: r.id, key: r.key, displayName: r.display_name, mediamtxPath: r.mediamtx_path,
      previewProtocol: r.preview_protocol, playbackUrlOverride: r.playback_url_override,
      sortOrder: r.sort_order, active: r.active,
    })) });
  })
);

// Assign saved (team-scoped) sources to a game + set display order via a
// join table (game_sources). No cloning: the template source is shared, so
// the UI matches by the same source id before/after assignment. Body:
// { assignments: [{ sourceId, sortOrder }] } or { sourceIds: [...] }.
const assignSchema = z.object({
  assignments: z.array(z.object({ sourceId: z.string().uuid(), sortOrder: z.number().int().min(0) })).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
}).refine((v) => v.assignments || v.sourceIds, 'provide assignments or sourceIds');

gamesRouter.post(
  '/:id/sources',
  requireAuth,
  requireRole('admin', 'operator'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const parsed = assignSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    const gameId = req.params.id;
    const list: { sourceId: string; sortOrder: number }[] = parsed.assignments
      ? parsed.assignments
      : parsed.sourceIds!.map((sourceId, i) => ({ sourceId, sortOrder: i }));

    await withTransaction(async (c) => {
      // Replace the game's source set: delete rows not in the new list.
      const keep = list.map((l) => l.sourceId);
      await c.query(
        `delete from game_sources where game_id = $1 and not (source_id = any($2::uuid[]))`,
        [gameId, keep]
      );
      for (const item of list) {
        // Verify the source belongs to the operator's team (or admin).
        const src = await c.query('select team_id from sources where id = $1', [item.sourceId]);
        if (!src.rows[0]) continue;
        if (ar.role !== 'admin' && !ar.teamIds.includes(src.rows[0].team_id)) {
          throw forbidden('not a member of this team');
        }
        await c.query(
          `insert into game_sources (game_id, source_id, sort_order)
           values ($1, $2, $3)
           on conflict (game_id, source_id) do update set sort_order = excluded.sort_order`,
          [gameId, item.sourceId, item.sortOrder]
        );
      }
    });
    await audit({ actorId: ar.userId, action: 'game.assign_sources', entityType: 'game', entityId: gameId, after: list, requestId: res.locals.requestId });
    res.json({ data: { ok: true, count: list.length } });
  })
);
