-- 0003_worker_heartbeats.sql — worker liveness/observability (Phase 7).
-- Each worker writes a heartbeat row every tick; readiness reports the
-- newest heartbeat per worker id and flags stale/dead workers. This is
-- append-bounded: we keep only the latest row per worker (upsert).

create table worker_heartbeats (
  worker_id text primary key,
  last_seen_at timestamptz not null default now(),
  status text not null default 'idle' check (status in ('idle','processing','error')),
  last_job_id uuid,
  last_error text,
  updated_at timestamptz not null default now()
);

create index worker_heartbeats_seen_idx on worker_heartbeats (last_seen_at desc);
