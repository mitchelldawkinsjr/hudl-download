# ADR 0005 — External MediaMTX, HTTP-Fetch Recording Access

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes/Amends:** Spec §MediaMTX Configuration, §Environment variables

## Context

MediaMTX is already running on a separate host. Film Room should connect to
that existing instance, not run or manage its own. The worker needs recording
segments to build review clips; with MediaMTX remote, there is no shared disk
to read fMP4 files from.

## Decision

- **MediaMTX is an external dependency.** Film Room connects to it over its
  Control API and playback/HTTP endpoints, configured through the Sources &
  Settings screen (Phase 2). Film Room's `docker-compose.yml` does **not**
  include a `mediamtx` service; a `docker-compose.dev.yml` provides a test-only
  container for local/CI use.
- **Recording access is over HTTP.** The worker queries MediaMTX's
  playback/list HTTP endpoint for segments overlapping the requested window and
  downloads segments into a job-scoped temp directory before running FFmpeg.
  There is no `RECORDINGS_ROOT` shared-volume mount. The env var
  `MEDIAMTX_RECORDING_HTTP_BASE` (plus the saved `private_playback_base`)
  replaces `RECORDINGS_ROOT`.
- **Path creation** is via the external MediaMTX Control API
  (`private_api_base`) when permitted; otherwise the admin configures sources
  against paths that already exist on the external instance, and Film Room
  records which path each source uses.
- An **adapter boundary** in `worker/src/recordings.ts` isolates segment
  fetching so a shared-volume mode could be added later without touching the
  FFmpeg pipeline.

## Connection contract (configured in Settings → Video Sources)

| Boundary | Setting | Used by |
|---|---|---|
| Control API | `private_api_base` | API server (path status, create paths) |
| Recording/segment HTTP | `private_playback_base` / `MEDIAMTX_RECORDING_HTTP_BASE` | Worker |
| Public playback | `public_playback_base`, `webrtc_public_base`, `hls_public_base` | Browser preview |
| RTMP | `rtmp_host`:`rtmp_port` | Publishing-settings copy screen |

## Consequences

- The Film Room host needs network reachability to the external MediaMTX
  Control API (private) and recording HTTP endpoint (private), and browsers need
  reachability to the public playback origin (directly or via the reverse
  proxy).
- Every clip job pulls segment bytes over the network; this is acceptable for
  the MVP's coach-usable pace and keeps the deployment simple (no NFS/SSHFS).
- A reference `infra/examples/mediamtx-reference.yml` documents the path
  convention and recording settings the external instance must match; it is
  not a file Film Room writes to the MediaMTX host.
