# ADR 0001 — Deployment Audit

- **Status:** Accepted
- **Date:** 2026-09-15
- **Decider:** Mitchell Dawkins

## Context

Phase 0 of the live multi-angle buildout requires confirming the current
production branch, deployment process, web root, reverse proxy, TLS
termination, and service-worker cache strategy before any live code lands, so
the existing public behavior is preserved as a regression gate.

## Findings

- **Repository:** `https://github.com/mitchelldawkinsjr/hudl-download`, default
  branch `main`, currently checked out on `main`.
- **Deployed app:** `https://filmroom.360web.cloud/` — the vanilla-JS PWA at
  `web/index.html`.
- **Reverse proxy / TLS:** Nginx Proxy Manager (NPM). Full HTTP+HTTPS server
  block lives in [`scripts/nginx-proxy-host-37.conf`](../../scripts/nginx-proxy-host-37.conf)
  (proxy-host-37). TLS terminated at NPM via a Let's Encrypt cert issued by
  certbot into NPM's own layout (`/etc/letsencrypt/live/npm-104/`); NPM's
  renewal timer renews it automatically. HSTS preload header is set on HTTPS.
- **Upstream:** NPM proxies to an internal service named `filmroom-web` on
  port 80 (`set $server filmroom-web; set $port 80;`). That service serves the
  static `web/` + `shared/` assets.
- **Service worker:** [`sw.js`](../../sw.js) at the repo root (not under
  `web/`) so its scope covers both `web/` and `shared/`. Cache name is
  `film-room-shell-v11`; cache-first for the app shell, network fallback with
  re-population. Video files are local blob/file URLs and never hit the SW.
- **Asset caching:** NPM applies `assets.conf` (standard NPM static-asset
  caching) on top of the SW.

## Consequences

- Any change to `web/` or `shared/` shell assets must bump `CACHE_NAME` in
  `sw.js` so installed PWAs pick up the update.
- The live API/worker stack (Phases 1+) will be deployed alongside this proxy;
  NPM routes `/api/` and `/events` to the new API service, static to
  `filmroom-web`, and RTMP/RTMPS directly to the external MediaMTX host.
- No secrets, filesystem paths, or DB credentials are exposed to the browser;
  this is preserved as a hard rule for all new work.
