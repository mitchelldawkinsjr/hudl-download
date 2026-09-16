// Events route: GET /games/:id/events?since=<id> — append-only event log for
// the live UI (Phase 4). Clients poll this to surface angle status changes
// without refresh. Returns events with id > since, oldest first, capped.
import { Router } from 'express';
import { query } from '../db/client.js';
import { asyncHandler, badRequest, requireUuid } from '../middleware/error.js';
import { requireAuth, requireTeam } from '../middleware/auth.js';

export const eventsRouter = Router();

eventsRouter.get(
  '/games/:id/events',
  requireAuth,
  requireTeam(async (req) => {
    requireUuid(req.params.id, 'game');
    const { rows } = await query('select team_id from games where id = $1', [req.params.id], { tag: 'games.getTeam' });
    return rows[0]?.team_id ?? null;
  }),
  asyncHandler(async (req, res) => {
    const since = req.query.since ? parseInt(String(req.query.since), 10) : 0;
    if (!Number.isFinite(since) || since < 0) throw badRequest('since must be a non-negative integer');
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const { rows } = await query(
      `select id, game_id, type, play_id, angle_id, payload_json, created_at
         from events
        where game_id = $1 and id > $2
        order by id asc
        limit $3`,
      [req.params.id, since, limit],
      { tag: 'events.list' }
    );
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        gameId: r.game_id,
        type: r.type,
        playId: r.play_id,
        angleId: r.angle_id,
        payload: typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json,
        createdAt: r.created_at,
      })),
    });
  })
);
