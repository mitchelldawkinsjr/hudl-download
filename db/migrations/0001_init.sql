-- 0001_init.sql — initial schema: users, teams, sessions, games, sources,
-- mediamtx_server_settings, source_status_snapshots, plays, play_angles,
-- media_jobs, telestrations, audit_events.
--
-- Conventions: UUID PKs, timestamptz for all absolute timestamps, UTC storage,
-- integer milliseconds for offsets/durations, FKs + check constraints + indexes.

create extension if not exists "pgcrypto";

-- ---------- users ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text,                      -- null when external_subject is set
  external_subject text,                    -- OIDC subject if an IdP is used
  role text not null check (role in ('admin','operator','reviewer')),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (password_hash is not null or external_subject is not null)
);
create index users_role_idx on users (role) where disabled_at is null;

-- ---------- teams ----------
create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- team membership ----------
create table team_members (
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  primary key (user_id, team_id)
);
create index team_members_team_idx on team_members (team_id);

-- ---------- games ----------
create table games (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  opponent text not null,
  venue text,
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  status text not null default 'draft' check (status in ('draft','live','ended','archived')),
  next_play_number int not null default 1,
  pre_roll_ms int not null default 18000 check (pre_roll_ms >= 0),
  post_roll_ms int not null default 3000 check (post_roll_ms >= 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index games_team_idx on games (team_id);
create index games_status_idx on games (status);

-- ---------- mediamtx_server_settings ----------
-- Singleton per team (team_id nullable = global default). The Sources &
-- Settings screen reads/writes this; private values stay server-side.
create table mediamtx_server_settings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) on delete cascade,  -- null = global
  public_playback_base text,                -- browser-facing origin
  private_api_base text,                      -- server -> MediaMTX Control API
  private_playback_base text,                  -- server/worker -> recording HTTP
  webrtc_public_base text,
  hls_public_base text,
  rtmp_host text,
  rtmp_port int not null default 1935 check (rtmp_port > 0 and rtmp_port < 65536),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id)
);

-- ---------- sources ----------
-- key is a free-form label (e.g. 'drone','press-box'), NOT a fixed enum
-- (ADR 0004). mediamtx_path is unique + sanitized by the API.
create table sources (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  game_id uuid references games(id) on delete cascade,  -- null = reusable template
  key text not null,                                   -- e.g. 'drone'
  display_name text not null,
  mediamtx_path text not null,                         -- sanitized, unique below
  preview_protocol text not null default 'hls' check (preview_protocol in ('hls','webrtc')),
  playback_url_override text,                            -- advanced reverse-proxy override
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mediamtx_path ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$')
);
-- Template (reusable, game_id null) paths are unique per team; game-scoped
-- copies are unique per (team, game) so a template 'drone' and a game's
-- cloned 'drone' can coexist.
create unique index sources_team_path_idx on sources (team_id, mediamtx_path) where game_id is null;
create unique index sources_game_path_idx on sources (team_id, game_id, mediamtx_path) where game_id is not null;
create index sources_game_idx on sources (game_id) where game_id is not null;
create index sources_team_active_idx on sources (team_id, sort_order) where active;

-- ---------- game_sources ----------
-- Join table: a game references reusable (team-scoped) source templates
-- with a display order. No cloning: the template source is shared, so the
-- UI matches by the same source id before/after assignment.
create table game_sources (
  game_id uuid not null references games(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  primary key (game_id, source_id)
);
create index game_sources_game_idx on game_sources (game_id, sort_order);

-- ---------- source_status_snapshots ----------
create table source_status_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  observed_at timestamptz not null default now(),
  state text not null check (state in ('connected','stale','offline')),
  publisher_present boolean,
  readers int,
  bytes_received bigint,
  codec_json jsonb,
  error_code text
);
create index source_status_snapshots_source_time_idx on source_status_snapshots (source_id, observed_at desc);

-- ---------- plays ----------
create table plays (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  play_number int not null,
  mark_time timestamptz not null,
  requested_start_time timestamptz not null,
  requested_end_time timestamptz not null,
  status text not null default 'processing' check (status in ('processing','partial','ready','failed','deleted')),
  quarter int,
  game_clock text,
  down int,
  distance int,
  yard_line text,
  result text,
  play_type text,
  notes text,
  marked_by uuid references users(id),
  version int not null default 1,
  idempotency_key text,                    -- dedup for Mark Play retries
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, play_number)
);
create unique index plays_game_idempotency_key_idx on plays (game_id, idempotency_key) where idempotency_key is not null;
create index plays_game_number_idx on plays (game_id, play_number);
create index plays_game_status_idx on plays (game_id, status);

-- ---------- play_angles ----------
create table play_angles (
  id uuid primary key default gen_random_uuid(),
  play_id uuid not null references plays(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','processing','ready','missing','failed')),
  requested_start_time timestamptz not null,
  requested_end_time timestamptz not null,
  actual_start_time timestamptz,
  actual_end_time timestamptz,
  sync_offset_ms int not null default 0 check (sync_offset_ms between -5000 and 5000),
  clip_uri text,
  thumbnail_uri text,
  duration_ms int,
  width int,
  height int,
  fps numeric(8,3),
  codecs text,
  checksum text,
  error_code text,
  error_message text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (play_id, source_id)
);
create index play_angles_play_idx on play_angles (play_id);
create index play_angles_status_idx on play_angles (status);

-- ---------- media_jobs ----------
create table media_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,                       -- e.g. 'clip'
  play_angle_id uuid references play_angles(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','dead')),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,                            -- worker id
  attempts int not null default 0,
  max_attempts int not null default 3,
  payload_json jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index media_jobs_run_after_idx on media_jobs (run_after) where status = 'queued';
create index media_jobs_status_idx on media_jobs (status);

-- ---------- telestrations ----------
create table telestrations (
  id uuid primary key default gen_random_uuid(),
  play_id uuid not null references plays(id) on delete cascade,
  angle_id uuid references play_angles(id) on delete cascade,  -- null = shared
  author_id uuid not null references users(id) on delete cascade,
  time_ms int not null check (time_ms >= 0),
  strokes_json jsonb not null default '[]'::jsonb,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (play_id, angle_id, author_id, time_ms)
);
create index telestrations_play_idx on telestrations (play_id);

-- ---------- audit_events ----------
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_events_actor_idx on audit_events (actor_id);
create index audit_events_entity_idx on audit_events (entity_type, entity_id);

-- ---------- updated_at trigger ----------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in select unnest(array[
            'users','teams','games','mediamtx_server_settings','sources',
            'plays','play_angles','media_jobs','telestrations'
          ]) loop
    execute format('drop trigger if exists trg_touch_%I on %I', t, t);
    execute format('create trigger trg_touch_%I before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end$$;
