// Event emitter: writes append-only rows to the `events` table so the live UI
// can surface angle status changes without refresh (Phase 4). The API polls
// GET /games/:id/events?since=<id>; a future WS/SSE layer can fan-out from
// this table.
import { query } from './db.js';

// The only event type this worker emits today.
const ANGLE_UPDATED = 'play.angle.updated';

export async function emitAngleEvent(
  angleId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Look up game/play for the angle (one round-trip) and insert the event.
  const { rows } = await query(
    `select p.game_id, pa.play_id
       from play_angles pa join plays p on p.id = pa.play_id
      where pa.id = $1`,
    [angleId],
    'event.lookup'
  );
  if (!rows[0]) return; // angle gone; nothing to emit
  await query(
    `insert into events (game_id, type, play_id, angle_id, payload_json)
     values ($1, $2, $3, $4, $5)`,
    [rows[0].game_id, ANGLE_UPDATED, rows[0].play_id, angleId, JSON.stringify(payload)],
    'event.insert'
  );
}
