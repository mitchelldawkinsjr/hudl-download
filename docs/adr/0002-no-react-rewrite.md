# ADR 0002 — No React Rewrite

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes/Amends:** Spec §Primary implementation decision

## Context

The Film Room viewer is a plain HTML/CSS/JS PWA today (`web/index.html`,
`web/app.js`, `shared/player.js`). The live multi-angle spec explicitly
directs the implementer **not** to rewrite the client in React during this
project, and to extend the existing vanilla client instead.

## Decision

Do not introduce a framework. Extend the existing vanilla HTML/CSS/JS client
additively. New live functionality is added as separate view fragments and
controller scripts under `web/js/`, mounted from `web/index.html` through a
lightweight mode coordinator. The shared player engine
[`shared/player.js`](../../shared/player.js) keeps its
`TelestrationPlayer({ video, canvas })` constructor and public methods intact;
new behavior is additive hooks only (external-clock, source-change).

## Consequences

- The Electron app and the downloader extension keep working unchanged.
- Offline local-film review remains the default when `LIVE_FILMROOM_ENABLED=false`.
- Regression tests for the current viewer are a gate at every phase.
- New UI states (loading/empty/partial/error/reconnecting/unauthorized) are
  implemented in the same vanilla style, not via a framework's state model.
