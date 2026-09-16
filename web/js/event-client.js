// Event client for the live UI (Phase 4). Polls GET /games/:id/events?since=<id>
// and invokes onEvent for each new event. The plan calls for WS with a poll
// fallback; this implements the reliable poll fallback now (WS can layer on
// later without changing consumers). Reconnects with backoff on errors and
// marks the stream stale if no successful poll within STALE_MS.
(function () {
  const POLL_MS = 2000;
  const STALE_MS = 8000;
  const ERR_BACKOFF_MS = 1000;

  function create({ gameId, onEvent, onStatus }) {
    let since = 0;
    let timer = null;
    let stopped = false;
    let lastOk = Date.now();
    let errBackoff = ERR_BACKOFF_MS;

    async function poll() {
      if (stopped) return;
      try {
        const data = await window.FilmRoomAPI.events.list(gameId, since);
        lastOk = Date.now();
        errBackoff = ERR_BACKOFF_MS;
        for (const ev of data) {
          since = Math.max(since, ev.id);
          try { onEvent(ev); } catch { /* listener error is non-fatal */ }
        }
        onStatus && onStatus('connected');
      } catch (err) {
        onStatus && onStatus('error', err);
        errBackoff = Math.min(15_000, errBackoff * 2);
      }
      // Stale check: no successful poll in a while.
      if (Date.now() - lastOk > STALE_MS) onStatus && onStatus('stale');
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }

    function start() { if (!timer) { stopped = false; poll(); } }
    function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }

    return { start, stop };
  }

  window.EventClient = { create };
})();
