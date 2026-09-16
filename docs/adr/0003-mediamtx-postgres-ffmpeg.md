# ADR 0003 — MediaMTX + PostgreSQL + FFmpeg

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes/Amends:** Spec §System Architecture

## Context

The live system needs a transport/recording layer for two RTMP feeds over
Starlink, an authoritative application-state store, and a way to produce
browser-playable review clips from continuous recordings.

## Decision

- **MediaMTX** is the transport and recording layer (accepts RTMP publishers,
  exposes HLS/WebRTC playback, records segmented fMP4). See ADR 0005 — MediaMTX
  is an **external** instance on a separate host, not run by Film Room.
- **PostgreSQL 15+** is the authoritative application state: games, sources,
  plays, angles, jobs, telestrations, audit events. UUID PKs, `timestamptz`
  UTC, integer-millisecond offsets/durations, FKs + check constraints + indexes
  via versioned migrations.
- **FFmpeg/ffprobe** (in a Node worker) produces derived review clips:
  stream-copy/remux first, transcode to H.264 yuv420p + AAC MP4 `+faststart`
  only when needed, probe-validate, thumbnail. FFmpeg runs non-root via
  `spawn` with an argument array — never a shell.

## Consequences

- The worker reads source records from Postgres to locate each angle's
  MediaMTX recording path; it never relies on a live preview URL.
- Derived clips land under `/media/games/{gameId}/plays/{playId}/` with opaque
  server-generated names; user labels never become paths.
- Retention is split: continuous-segment retention (MediaMTX side) vs
  derived-clip retention (Film Room side), each independently configurable.
