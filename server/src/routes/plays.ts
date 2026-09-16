// Plays routes: Mark Play (idempotent, play-number allocation in one tx),
// list, get, patch (optimistic concurrency), delete (soft), retry, sync
// offset. Mark Play creates one play_angle per active game source and queues
// a clip job per angle using each source's saved mediamtx_path.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, badRequest, notFound, conflict, requireUuid } from '../middleware/error.js';
import { requireAuth, requireRole, requireTeam, type AuthedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

export const playsRouter = Router();

// Mark Play / retry abuse protection: 60 writes/min per IP. Prevents a runaway
// client or a bad loop from flooding the job queue.
const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, scope: 'plays.write' });

const markSchema = z.object({
  quarter: z.number().int().min(0).max(10).nullable().optional(),
  gameClock: z.string().max(20).nullable().optional(),
  preRollMs: z.number().int().min(0).max(600000).nullable().optional(),
  postRollMs: z.number().int().min(0).max(600000).nullable().optional(),
  idempotencyKey: z.string().max(200).optional(), // body fallback for header
});

function playToJson(r: Record<string, unknown>, angles: Record<string, unknown>[] = []) {
  return {
    id: r.id,
    gameId: r.game_id,
    playNumber: r.play_number,
    status: r.status,
    markTime: r.mark_time,
    requestedStartTime: r.requested_start_time,
    requestedEndTime: r.requested_end_time,
    quarter: r.quarter,
    gameClock: r.game_clock,
    down: r.down,
    distance: r.distance,
    yardLine: r.yard_line,
    result: r.result,
    playType: r.play_type,
    notes: r.notes,
    version: r.version,
    angles,
  };
}

// POST /games/:id/plays — Mark Play. Idempotent via Idempotency-Key header
// (or body.idempotencyKey). Allocates the play number inside one transaction
// by locking the game row and incrementing next_play_number.
playsRouter.post(
  '/games/:gameId/plays',
  requireAuth,
  requireRole('admin', 'operator'),
  writeLimiter,
  requireTeam(async (req) => {
    requireUuid(req.params.gameId, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.gameId], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const parsed = markSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    const gameId = req.params.gameId;
    const idempotencyKey = (req.headers['idempotency-key'] as string) || parsed.idempotencyKey || null;

    const result = await withTransaction(async (c) => {
      // Idempotency: if a play already exists for this key+game, return it.
      if (idempotencyKey) {
        const ex = await c.query(
          `select * from plays where game_id = $1 and idempotency_key = $2 and status <> 'deleted'`,
          [gameId, idempotencyKey]
        );
        if (ex.rows[0]) {
          const angles = await c.query(
            `select pa.*, s.key as source_key, s.mediamtx_path, s.display_name as source_display_name
             from play_angles pa join sources s on s.id = pa.source_id
             where pa.play_id = $1 order by s.sort_order`,
            [ex.rows[0].id]
          );
          return { play: ex.rows[0], angles: angles.rows, created: false };
        }
      }

      // Lock the game row.
      const g = await c.query('select * from games where id = $1 for update', [gameId]);
      const game = g.rows[0];
      if (!game) throw notFound('game');
      if (game.status !== 'live') throw badRequest('game is not live; cannot mark plays');

      const preRoll = parsed.preRollMs ?? game.pre_roll_ms;
      const postRoll = parsed.postRollMs ?? game.post_roll_ms;
      const markTime = new Date(); // authoritative server UTC
      const requestedStart = new Date(markTime.getTime() - preRoll);
      const requestedEnd = new Date(markTime.getTime() + postRoll);
      const playNumber = game.next_play_number;

      // Active assigned sources for this game (via the join table) — one
      // angle per source.
      const srcs = await c.query(
        `select s.id, s.key, s.mediamtx_path, s.display_name, gs.sort_order
         from game_sources gs
         join sources s on s.id = gs.source_id
         where gs.game_id = $1 and s.active
         order by gs.sort_order, s.display_name`,
        [gameId]
      );
      if (srcs.rows.length < 1) throw badRequest('game has no active sources');

      const play = await c.query(
        `insert into plays
           (game_id, play_number, mark_time, requested_start_time, requested_end_time,
            quarter, game_clock, marked_by, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [gameId, playNumber, markTime, requestedStart, requestedEnd,
         parsed.quarter ?? null, parsed.gameClock ?? null, ar.userId, idempotencyKey]
      );
      await c.query('update games set next_play_number = $2 where id = $1', [gameId, playNumber + 1]);

      const angles = [];
      for (const s of srcs.rows) {
        const a = await c.query(
          `insert into play_angles
             (play_id, source_id, status, requested_start_time, requested_end_time)
           values ($1,$2,'queued',$3,$4) returning *`,
          [play.rows[0].id, s.id, requestedStart, requestedEnd]
        );
        // Queue a clip job. run_after = requested_end_time + RECORDING_SETTLE_MS.
        const runAfter = new Date(requestedEnd.getTime() + Number(process.env.RECORDING_SETTLE_MS || 2000));
        await c.query(
          `insert into media_jobs (type, play_angle_id, status, run_after, payload_json)
           values ('clip', $1, 'queued', $2, $3)`,
          [a.rows[0].id, runAfter, JSON.stringify({ sourceId: s.id, mediamtxPath: s.mediamtx_path })]
        );
        angles.push({ ...a.rows[0], source_key: s.key, mediamtx_path: s.mediamtx_path, source_display_name: s.display_name });
      }
      return { play: play.rows[0], angles, created: true };
    });

    await audit({
      actorId: ar.userId,
      action: result.created ? 'play.create' : 'play.create_idempotent',
      entityType: 'play',
      entityId: result.play.id,
      requestId: res.locals.requestId,
    });
    res.status(result.created ? 202 : 200).json({ data: playToJson(result.play, result.angles) });
  })
);

playsRouter.get(
  '/games/:gameId/plays',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.gameId, 'game'); const { rows } = await query('select team_id from games where id = $1', [req.params.gameId], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || undefined;
    let sql = `select * from plays where game_id = $1`;
    const params: unknown[] = [req.params.gameId];
    if (status) {
      sql += ` and status = $2`;
      params.push(status);
    }
    sql += ` order by play_number desc limit 200`;
    const { rows } = await query(sql, params, { tag: 'plays.list' });
    // Include per-angle status chips (live recent-plays needs them).
    const ids = rows.map((r) => r.id);
    let anglesByPlay: Record<string, Record<string, unknown>[]> = {};
    if (ids.length) {
      const ar = await query(
        `select pa.*, p.id as play_id, s.key as source_key, s.mediamtx_path
           from play_angles pa
           join plays p on p.id = pa.play_id
           join sources s on s.id = pa.source_id
          where p.id = any($1::uuid[])
          order by p.id, s.sort_order`,
        [ids],
        { tag: 'plays.list.angles' }
      );
      for (const a of ar.rows) {
        (anglesByPlay[a.play_id] ||= []).push({
          id: a.id, sourceId: a.source_id, sourceKey: a.source_key,
          status: a.status, clipUri: a.clip_uri, errorCode: a.error_code,
          syncOffsetMs: a.sync_offset_ms,
        });
      }
    }
    res.json({ data: rows.map((r) => playToJson(r, anglesByPlay[r.id] || [])) });
  })
);

playsRouter.get(
  '/plays/:id',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await query('select * from plays where id = $1', [req.params.id], { tag: 'plays.get' });
    if (!rows[0]) throw notFound('play');
    const angles = await query(
      `select pa.*, s.key as source_key, s.mediamtx_path, s.display_name as source_display_name
       from play_angles pa join sources s on s.id = pa.source_id
       where pa.play_id = $1 order by s.sort_order`,
      [req.params.id]
    );
    res.json({ data: playToJson(rows[0], angles.rows.map((a) => ({
      id: a.id, sourceId: a.source_id, sourceKey: a.source_key,
      status: a.status, clipUri: a.clip_uri, thumbnailUri: a.thumbnail_uri,
      durationMs: a.duration_ms, width: a.width, height: a.height, fps: a.fps,
      codecs: a.codecs, checksum: a.checksum, syncOffsetMs: a.sync_offset_ms,
      errorCode: a.error_code, errorMessage: a.error_message,
      requestedStartTime: a.requested_start_time, requestedEndTime: a.requested_end_time,
      actualStartTime: a.actual_start_time, actualEndTime: a.actual_end_time,
    }))) });
  })
);

const patchSchema = z.object({
  quarter: z.number().int().min(0).max(10).nullable().optional(),
  gameClock: z.string().max(20).nullable().optional(),
  down: z.number().int().min(0).max(4).nullable().optional(),
  distance: z.number().int().min(0).max(100).nullable().optional(),
  yardLine: z.string().max(20).nullable().optional(),
  result: z.string().max(200).nullable().optional(),
  playType: z.string().max(80).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  version: z.number().int().positive(),
});

playsRouter.patch(
  '/plays/:id',
  requireAuth,
  requireRole('admin', 'operator'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    // Optimistic concurrency via If-Match (version) or body.version.
    const ifMatch = req.headers['if-match'];
    const expectedVersion = ifMatch ? parseInt(String(ifMatch).replace(/"/g, ''), 10) : parsed.version;
    if (expectedVersion == null || Number.isNaN(expectedVersion)) {
      throw badRequest('version is required for optimistic concurrency');
    }
    const { rows } = await query(
      `update plays set
         quarter = coalesce($1, quarter),
         game_clock = coalesce($2, game_clock),
         down = coalesce($3, down),
         distance = coalesce($4, distance),
         yard_line = coalesce($5, yard_line),
         result = coalesce($6, result),
         play_type = coalesce($7, play_type),
         notes = coalesce($8, notes),
         version = version + 1
       where id = $9 and version = $10 returning *`,
      [
        parsed.quarter ?? null, parsed.gameClock ?? null, parsed.down ?? null, parsed.distance ?? null,
        parsed.yardLine ?? null, parsed.result ?? null, parsed.playType ?? null, parsed.notes ?? null,
        req.params.id, expectedVersion,
      ],
      { tag: 'plays.update' }
    );
    if (!rows[0]) {
      // Either wrong version or not found — distinguish.
      const exists = await query('select id from plays where id = $1', [req.params.id], { tag: 'plays.exists' });
      if (!exists.rows[0]) throw notFound('play');
      throw conflict('version mismatch; reload the play');
    }
    await audit({ actorId: ar.userId, action: 'play.update', entityType: 'play', entityId: req.params.id, after: parsed, requestId: res.locals.requestId });
    res.json({ data: playToJson(rows[0]) });
  })
);

playsRouter.delete(
  '/plays/:id',
  requireAuth,
  requireRole('admin', 'operator'),
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query(
      `update plays set status = 'deleted' where id = $1 and status <> 'deleted' returning id`,
      [req.params.id],
      { tag: 'plays.delete' }
    );
    if (rows[0]) {
      await audit({ actorId: ar.userId, action: 'play.delete', entityType: 'play', entityId: req.params.id, requestId: res.locals.requestId });
    }
    res.json({ data: { ok: true } });
  })
);

playsRouter.post(
  '/plays/:id/retry',
  requireAuth,
  requireRole('admin', 'operator'),
  writeLimiter,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'play'); const { rows } = await query('select team_id from plays p join games g on g.id = p.game_id where p.id = $1', [req.params.id], { tag: 'plays.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true';
    const angles = await query(
      `select pa.*, s.mediamtx_path from play_angles pa
       join sources s on s.id = pa.source_id
       where pa.play_id = $1 and (pa.status in ('missing','failed') or $2 = true)
       order by s.sort_order`,
      [req.params.id, force]
    );
    const queued = [];
    for (const a of angles.rows) {
      const runAfter = new Date(Date.now() + Number(process.env.RECORDING_SETTLE_MS || 2000));
      await query(
        `insert into media_jobs (type, play_angle_id, status, run_after, payload_json)
         values ('clip', $1, 'queued', $2, $3)`,
        [a.id, runAfter, JSON.stringify({ sourceId: a.source_id, mediamtxPath: a.mediamtx_path, retry: true })]
      );
      queued.push(a.id);
    }
    res.json({ data: { ok: true, queuedAngleIds: queued } });
  })
);

const syncSchema = z.object({ syncOffsetMs: z.number().int().min(-5000).max(5000) });

playsRouter.patch(
  '/play-angles/:id/sync',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const parsed = syncSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    const { rows } = await query(
      `update play_angles set sync_offset_ms = $2 where id = $1 returning *`,
      [req.params.id, parsed.syncOffsetMs],
      { tag: 'play_angles.sync' }
    );
    if (!rows[0]) throw notFound('play angle');
    await audit({ actorId: ar.userId, action: 'play_angle.sync', entityType: 'play_angle', entityId: req.params.id, after: parsed, requestId: res.locals.requestId });
    res.json({ data: { id: rows[0].id, syncOffsetMs: rows[0].sync_offset_ms } });
  })
);
