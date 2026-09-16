# ADR 0004 — Configurable Sources via UI (OSEE dropped)

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes/Amends:** Spec §Product Scope, §MediaMTX Configuration (OSEE)

## Context

The original spec assumed two fixed source types: a DJI drone and an OSEE
GoStream. The actual field setup is a DJI drone plus a **press-box camera**
(capture card + laptop running OBS). OSEE is no longer required. More
generally, sources should be administrator-configurable through the UI rather
than hardcoded, so the system can adapt to different camera setups without code
or config-file edits.

## Decision

Sources are administrator-configured through a **Settings → Video Sources**
screen (Phase 2), persisted in the backend. Each source has a display name, a
unique sanitized MediaMTX stream path, a preferred browser playback protocol
(HLS or WebRTC), an optional playback-URL override, an active toggle, and a
sort order. The `sources.key` is a free-form label (e.g. `drone`,
`press-box`), not a fixed enum. OSEE-specific assumptions are removed from the
codebase and plan.

## Consequences

- No hardcoded `/drone` + `/osee` globals; MediaMTX paths are derived from
  saved source records.
- A game opens by loading its assigned, ordered sources automatically.
- Mark Play creates one play-angle row per assigned source using each source's
  saved MediaMTX path to locate recordings.
- The Settings screen is admin/operator-gated and audited; sensitive publishing
  details (stream keys) are masked in the UI and kept server-side.
