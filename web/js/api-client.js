// Film Room API client — fetch wrapper with cookie auth, CSRF double-submit, and
// error-envelope parsing. Used by the admin Settings → Video Sources screen.
// Vanilla JS, no framework (ADR 0002). Same-origin /api/v1 by default (the
// reverse proxy routes /api/ to the API service in production); override with
// window.FILMROOM_API_BASE for local dev against a separate API port.
(function () {
  const BASE = (window.FILMROOM_API_BASE || '/api/v1').replace(/\/$/, '');

  let csrfToken = null;

  /** Read a cookie by name (for the csrf token the server also sets). */
  function getCookie(name) {
    const m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Core request. Handles CSRF header injection and error-envelope parsing. */
  async function request(method, path, { body, headers, raw } = {}) {
    const h = { ...(headers || {}) };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
      if (!csrfToken) csrfToken = getCookie('csrf');
      if (csrfToken) h['x-csrf-token'] = csrfToken;
    }
    const res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Refresh the csrf token from any set-cookie the server sent (the
    // browser does this automatically, but reading it keeps the in-memory
    // copy fresh for same-origin requests).
    csrfToken = getCookie('csrf') || csrfToken;

    if (res.status === 204) return null;
    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!res.ok) {
      const err = (parsed && parsed.error) || { code: 'http_error', message: res.statusText };
      const e = new Error(err.message || ('HTTP ' + res.status));
      e.code = err.code || 'http_error';
      e.status = res.status;
      e.details = err.details;
      throw e;
    }
    return raw ? res : (parsed && parsed.data !== undefined ? parsed.data : parsed);
  }

  window.FilmRoomAPI = {
    BASE,
    /** Prime the CSRF token (call after a GET that sets the cookie). */
    primeCsrf() { csrfToken = getCookie('csrf'); },

    auth: {
      login: (email, password) => request('POST', '/auth/login', { body: { email, password } }),
      logout: () => request('POST', '/auth/logout'),
      me: () => request('GET', '/auth/me'),
    },
    settings: {
      get: () => request('GET', '/settings'),
      put: (s) => request('PUT', '/settings', { body: s }),
    },
    sources: {
      list: (teamId) => request('GET', '/sources' + (teamId ? '?teamId=' + encodeURIComponent(teamId) : '')),
      create: (s) => request('POST', '/sources', { body: s }),
      update: (id, patch) => request('PATCH', '/sources/' + id, { body: patch }),
      remove: (id) => request('DELETE', '/sources/' + id),
      publishing: (id, gameId) => request('GET', '/sources/' + id + '/publishing' + (gameId ? '?gameId=' + encodeURIComponent(gameId) : '')),
      test: (id) => request('POST', '/sources/' + id + '/test'),
    },
    games: {
      list: (status) => request('GET', '/games' + (status ? '?status=' + status : '')),
      create: (g) => request('POST', '/games', { body: g }),
      get: (id) => request('GET', '/games/' + id),
      start: (id) => request('POST', '/games/' + id + '/start'),
      end: (id) => request('POST', '/games/' + id + '/end'),
      sources: (id) => request('GET', '/games/' + id + '/sources'),
      assign: (id, assignments) => request('POST', '/games/' + id + '/sources', { body: { assignments } }),
    },
    plays: {
      mark: (gameId, body, idempotencyKey) => request('POST', '/games/' + gameId + '/plays', {
        body: body || {}, headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
      }),
      list: (gameId, status) => request('GET', '/games/' + gameId + '/plays' + (status ? '?status=' + status : '')),
      get: (id) => request('GET', '/plays/' + id),
      patch: (id, body) => request('PATCH', '/plays/' + id, { body }),
      retry: (id, force) => request('POST', '/plays/' + id + '/retry' + (force ? '?force=true' : '')),
      syncAngle: (angleId, syncOffsetMs) => request('PATCH', '/play-angles/' + angleId + '/sync', { body: { syncOffsetMs } }),
    },
    events: {
      list: (gameId, since, limit) => request('GET', '/games/' + gameId + '/events?since=' + (since || 0) + (limit ? '&limit=' + limit : '')),
    },
  };
})();
