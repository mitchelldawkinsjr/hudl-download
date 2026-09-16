# Film Room — Live Multi-Angle System

The live system extends the offline Film Room viewer into a live football video
platform: two independent feeds (a DJI drone + a press-box camera on OBS +
capture card) publish into an **existing external MediaMTX instance** on a
separate host over Starlink. Film Room connects to that MediaMTX over its
Control API and HTTP recording endpoints — it does **not** run or manage
MediaMTX. It continuously records both angles, lets an operator mark plays,
generates synchronized review clips, and adds a Node/TypeScript API +
PostgreSQL + FFmpeg worker. The offline local-film viewer keeps working
without any of this.

Everything live is feature-flagged behind `LIVE_FILMROOM_ENABLED=false` until
its phase exit gate passes.

## Architecture

```
                         ┌─────────────────────────────────────┐
   Drone (RTMP) ───────► │                                     │
                         │   External MediaMTX (separate host) │
   Press Box (OBS RTMP)─►│   Control API · HLS/WebRTC · HTTP    │
                         │   recording segments                │
                         └───────────────┬─────────────────────┘
                                         │  (private network)
              ┌──────────────────────────┼───────────────────────────┐
              ▼                          ▼                           ▼
       ┌────────────┐            ┌──────────────┐             ┌──────────────┐
       │  API (TS)  │            │  Worker (TS)  │             │  Postgres    │
       │  Express   │◄──────────►│  FFmpeg clip  │◄──────────► │  (state)    │
       │  auth/CRUD │   poll      │  pipeline     │   jobs/rows │             │
       └─────┬──────┘  jobs      └──────┬───────┘             └──────────────┘
             │                          │ HTTP-fetch segments
             │ serves static web/       ▼
             │                   ┌──────────────┐
             ▼                   │  MEDIA_ROOT  │
       ┌────────────┐            │  (clips/thumbs)│
       │  Web client │            └──────────────┘
       │  (vanilla JS│
       │  PWA)       │
       └────────────┘
```

- **API** (`server/`): TS Express. Auth (Argon2id, cookie-session), games /
  sources / plays / events / media / telestrations, settings, SSRF guard,
  signed short-lived media URLs, rate limiting, audit events. Serves the
  static web client for same-origin cookies.
- **Worker** (`worker/`): polls `media_jobs`, leases one at a time (restart-
  safe leasing), fetches recording segments over HTTP from MediaMTX
  (`recordings.ts`), remuxes/transcodes via FFmpeg, validates, thumbnails,
  atomically moves into `MEDIA_ROOT`, updates `play_angles`, emits events,
  writes a heartbeat row each tick.
- **Postgres** (`db/migrations/`): authoritative state. UUID PKs, `timestamptz`
  UTC, integer-ms offsets/durations, FKs, check constraints, partial unique
  indexes. Migrations are forward-only; see Backup & rollback.
- **Web client** (`web/`): vanilla JS, additive over the existing PWA. Screens:
  `settings.html` (admin), `live.html` (operator), `review.html` (reviewer,
  single-angle + side-by-side). Reuses `shared/player.js` (`TelestrationPlayer`).

## Setup (dev)

```bash
# 1. Postgres
createdb filmroom

# 2. API
cd server && npm install
DATABASE_URL=postgres://<user>@localhost:5432/filmroom \
  SESSION_SECRET=<≥16 chars> npm run dev   # tsx watch, applies migrations

# 3. Worker (separate terminal)
cd worker && npm install
DATABASE_URL=postgres://<user>@localhost:5432/filmroom \
  MEDIAMTX_RECORDING_HTTP_BASE=http://<mediamtx-host>:9997 \
  MEDIA_OUTPUT_DIR=./media npm run dev

# 4. Web — serve the repo root so /web/* and /shared/* resolve
cd .. && python3 -m http.server 8934
# open http://localhost:8934/web/settings.html to configure sources
```

Configure the external MediaMTX connection on **Settings → Video Sources**:
private Control API base, private recording HTTP base, public playback bases,
RTMP host/port. Add the Drone and Press Box sources, test their previews,
assign them to a game, and start the game. The worker picks up marked plays
and produces clips.

## Publishing (game day)

1. On the MediaMTX host, confirm both paths are receiving (Drone RTMP +
   Press Box OBS). Film Room does not start or stop publishers.
2. In **Settings → Video Sources**, **Test connection** for each source. The
   preview distinguishes:
   - **working** — preview is live (publisher connected, HLS/WebRTC reachable).
   - **offline** — publisher absent or endpoint unreachable.
   A working preview is not the same as a recording-ready angle; the worker
   confirms the recording separately.
3. **Assign** both sources to the game and **Start game**.
4. Operator opens `live.html`, marks plays. Each Mark Play creates one
   `play_angle` per active game source and queues a clip job per angle.
5. The live UI updates in real time via the events poll
   (`GET /games/:id/events?since=<id>`): angle status moves `queued →
   processing → ready` (or `missing`/`failed`).
6. Reviewers open `review.html`, pick the play, switch angles (continuity is
   preserved across switches via logical play time + sync offset), or use the
   **Side by Side** tab for synchronized two-angle playback with drift
   correction and shared controls.

## Game-day checklist

- [ ] MediaMTX host reachable from the API host (`curl <private-api-base>`).
- [ ] Recording HTTP base reachable from the **worker** host (SSRF allowlist
      includes the private MediaMTX host: `SSRF_ALLOW_HOSTS=mediamtx.local`).
- [ ] `GET /api/v1/health/ready` → `db: ok`, workers `live`.
- [ ] Disk free on `MEDIA_ROOT` > 20%.
- [ ] Both sources preview **working** before kickoff.
- [ ] Flash/clap sync at the start of recording (gives a known anchor for
      side-by-side sync-offset calibration).

## Observability

- **Logs**: JSON via Pino (timestamp/level/service/requestId/jobId). Every
  response carries `x-request-id`.
- **Health**: `GET /api/v1/health/live` (liveness, dependency-free);
  `GET /api/v1/health/ready` (DB + worker heartbeats). A worker is `live`
  (heartbeat < 15s old), `stale` (15–60s), or `dead` (> 60s). Stale/dead
  workers are reported but do not by themselves fail readiness.
- **Metrics to wire** (fields already in logs/DB): HTTP latency/errors,
  mark-to-ready latency, queue depth, job attempts, FFmpeg duration, disk
  free, clip bytes, source uptime.
- **Alerts** (recommended): disk low, both sources offline, queue age high,
  repeated job failures, readiness `db: fail`, no live worker heartbeat.

## Security

- Auth: Argon2id password hashing, HTTP-only Secure SameSite=Lax session
  cookies, generic invalid-credentials error, constant-ish failure timing.
- Authorization: per-team/per-role checks on every game/play/media/event
  route; cross-team access returns 403 (or 404 where existence must not leak).
- CSRF: double-submit token via `cookie-session` + `cookie-parser`.
- Rate limiting: login 10/min/IP; play writes (mark/retry) 60/min/IP.
- SSRF guard: the worker/API only fetch from allowlisted hosts
  (`SSRF_ALLOW_HOSTS`); private/loopback ranges are denied by default.
- Media: non-enumerable paths (must know play+angle IDs); **signed
  short-lived tokens** (`POST /plays/:id/angles/:angleId/sign`) for share-out,
  HMAC-SHA256 scoped to play/angle/kind with a TTL (default 5 min, max 24 h).
  Session-based access remains the default for the review UI.
- FFmpeg: invoked via `spawn` with array args (never a shell); payload-size
  validation; MIME checks on output.
- Audit: `audit_events` records auth, source/play/telestration mutations.

## Retention & backups

- **Retention windows** are per-team (`retention_settings`): continuous
  recordings (managed by MediaMTX, not Film Room), derived clips (default
  30d), audit (default 365d). A NULL window means keep indefinitely.
- **Cleanup** (`scripts/retention-cleanup.ts`): run daily via cron. Dry-run
  by default; pass `--apply` to delete. It **never deletes media referenced by
  a non-deleted play** (AC19) — only soft-deleted plays past the derived
  window are purged (files + rows), and audit rows past the audit window.
  ```bash
  node --import tsx scripts/retention-cleanup.ts            # dry-run
  node --import tsx scripts/retention-cleanup.ts --apply    # delete
  ```
- **Postgres backup**: daily `pg_dump` of the filmroom database + a periodic
  restore test into a throwaway DB. Derived media under `MEDIA_ROOT` is
  regenerable from MediaMTX recordings (within the continuous window) but
  should also be backed up for fast review restore.

## Deployment & rollback

- **Images**: `infra/Dockerfile.api`, `infra/Dockerfile.worker` — non-root
  (`node` user), `dumb-init` for signal handling, healthchecks. Compose in
  `infra/docker-compose.yml` runs api/worker/db (no MediaMTX — that's
  external). `infra/docker-compose.dev.yml` adds a throwaway MediaMTX for CI.
- **Routing** (reverse proxy): `/api/` + `/events` → API; static → web;
  media (`/plays/:id/angles/:angleId/clip|thumbnail`) is served by the API
  behind auth (do not proxy high-bandwidth media through Node unless authz
  requires it — for share-out, prefer signed URLs to a CDN/origin in front of
  `MEDIA_ROOT`).
- **Migrations** are forward-only and run pre-rollout (`node --import tsx
  server/src/db/migrate.ts`). Each migration is paired with a forward-fix
  note in its header where a destructive change is involved.
- **Rollback**:
  1. **Image**: redeploy the previous image tag (containers are stateless).
  2. **DB**: do not roll back migrations (no down migrations). Apply a
     forward-fix migration that reverses the change if needed.
  3. **One-previous-version compat**: API + worker are version-skew tolerant
     within a minor release (the worker reads only columns it knows; new
     columns are nullable/defaulted). Do not roll the worker more than one
     version behind the API.
- **Service worker**: bump `CACHE_NAME` in `sw.js` on any shell change so
  installed copies pick up the update; never cache auth API/WS/live
  manifests/protected video.

## Field test runbook (Phase 7 gate)

A practice session on real Starlink + DJI + Press-Box-OBS + iPad before
relying on the system in a game:

1. **45-min stream** both sources into MediaMTX; confirm `health/ready`
   shows both workers `live` and both sources preview `working`.
2. **30+ plays** including back-to-back marks (idempotency) and a
   one-source-offline segment (Drone drops for 2 min, Press Box keeps
   streaming) — the dropped angle should land `missing`, not block the
   ready angle.
3. **Flash/clap sync** at the start: use it to calibrate the side-by-side
   sync offset and persist it (`Save offset`).
4. **Operator-mistake cases** (AC20): double-tap Mark Play (dedup),
   retry a failed angle, mark during a brief network blip.
5. **Review**: open `review.html` on an iPad, confirm continuity on angle
   switch, side-by-side drift < 0.5s over 60 s, telestration target
   switching, and missing-angle UX for the offline segment.
6. **Pass criteria**: all of the above with no manual DB/media fixups.

## Troubleshooting

| Symptom | Check |
|---|---|
| Preview `offline` | publisher connected to MediaMTX? public playback base reachable from browser? |
| Angle stuck `queued` | worker running? `health/ready` workers `live`? `media_jobs` rows `run_after` in the past? |
| Angle `missing` | recording HTTP base reachable from worker? SSRF allowlist includes the host? path exists in MediaMTX's recording index? |
| Angle `failed` (permanent) | `play_angles.error_message`; usually FFmpeg validation (no video stream / corrupt segment) — retry after fixing the publisher |
| Login `429` | rate limit (10/min/IP) — wait, or raise for a trusted operator IP |
| Review clip `401` w/ token | token expired or scope mismatch — re-sign |
| Review clip `403` | user not on the play's team |
| Side-by-side drift > 0.5s | calibrate sync offset (flash/clap), save, reload |
