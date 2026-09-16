-- 0002_events.sql — append-only event log for live UI updates (Phase 4).
-- The worker writes a row whenever a play_angle changes status; clients poll
-- GET /games/:id/events?since=<seq> (or an SSE/WS layer can fan-out from
-- here). Monotonic per-game sequence via a per-game serial; id is the global
-- cursor used by the `since` query param.
create table events (
  id bigserial primary key,
  game_id uuid not null references games(id) on delete cascade,
  type text not null,                       -- e.g. 'play.angle.updated'
  play_id uuid references plays(id) on delete cascade,
  angle_id uuid references play_angles(id) on delete cascade,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_game_id_idx on events (game_id, id);
create index events_type_idx on events (type);
