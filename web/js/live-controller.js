// Film Room Live operator controller (Phase 4). Vanilla JS, no framework
// (ADR 0002). Loads a game's assigned sources (DB-driven), renders muted
// live preview cards, Mark Play (idempotent + debounce), and a recent-plays
// list with per-angle status chips. An event client polls angle updates so a
// play becomes ready without refresh. Preview-working (card green) is
// distinct from recording-ready (chip ready): a source can have a working
// preview while its clip is still processing/missing.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.FilmRoomAPI;

  let me = null;
  let games = [];
  let currentGame = null;
  let sources = [];
  let serverSettings = null;
  let eventClient = null;
  let markDebounce = null;
  let lastIdempotencyKey = null;
  let previewPoll = null;

  // ---- login ----
  async function login(email, password) {
    const r = await fetch(api.BASE + '/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': getCookie('csrf') || '' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error((await r.json()).error?.message || 'login failed');
    api.primeCsrf();
  }
  function getCookie(name) { const m = document.cookie.match('(?:^|; )' + name + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }

  async function bootstrap() {
    me = await api.auth.me();
    if (!me) { showLogin(); return; }
    $('userTag').textContent = me.email || me.displayName || '';
    await enterLive();
  }

  async function enterLive() {
    serverSettings = await api.settings.get().catch(() => null);
    games = await api.games.list();
    renderGameSelect();
    if (games.length) await selectGame(games.find((g) => g.status === 'live')?.id || games[0].id);
    $('liveMain').hidden = false;
  }

  function renderGameSelect() {
    const sel = $('gameSelect');
    sel.innerHTML = '';
    for (const g of games) {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = `#${g.playNumber || 1} ${g.opponent} (${g.status})`;
      sel.appendChild(o);
    }
  }

  async function selectGame(id) {
    if (eventClient) eventClient.stop();
    currentGame = await api.games.get(id);
    sources = await api.games.sources(id);
    renderHeader();
    renderPreviews();
    renderMarkBar();
    await refreshRecent();
    startEvents();
    startPreviewPolling();
  }

  function renderHeader() {
    $('gameTitle').textContent = `${currentGame.opponent}`;
    const s = $('gameState'); s.textContent = currentGame.status; s.dataset.state = currentGame.status;
    $('startGameBtn').hidden = currentGame.status === 'live';
    $('endGameBtn').hidden = currentGame.status !== 'live';
  }

  // ---- previews ----
  function resolvePreviewUrl(src) {
    if (src.playbackUrlOverride) return src.playbackUrlOverride;
    const base = (serverSettings && (serverSettings.hlsPublicBase || serverSettings.publicPlaybackBase)) || '';
    if (!base) return '';
    return `${base.replace(/\/$/, '')}/games/${currentGame.id}/${src.mediamtxPath}/index.m3u8`;
  }

  function renderPreviews() {
    const grid = $('previewGrid');
    grid.innerHTML = '';
    for (const src of sources) {
      const card = document.createElement('div');
      card.className = 'preview-card';
      card.dataset.sourceId = src.id;
      card.dataset.preview = 'unknown';
      card.innerHTML = `
        <div class="preview-head">
          <span class="preview-name">${escapeHtml(src.displayName)}</span>
          <span class="preview-state" data-state="unknown">checking…</span>
        </div>
        <div class="preview-video-wrap">
          <video class="preview-video" muted playsinline></video>
          <div class="preview-placeholder">connecting…</div>
        </div>
        <div class="preview-foot">
          <span class="packet-age">—</span>
          <button class="retry-btn" type="button">retry</button>
        </div>`;
      grid.appendChild(card);
      attachPreview(card, src);
    }
  }

  function attachPreview(card, src) {
    const v = card.querySelector('.preview-video');
    const url = resolvePreviewUrl(src);
    if (url) {
      // hls.js if available (non-Safari); native HLS on Safari.
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ lowLatencyMode: true });
        hls.loadSource(url); hls.attachMedia(v);
        card._hls = hls;
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
      }
      v.muted = true;
      v.play().catch(() => { /* autoplay may be blocked; muted should allow */ });
    }
    card.querySelector('.retry-btn').addEventListener('click', () => pollPreviewState(src, card));
  }

  async function pollPreviewState(src, card) {
    const stateEl = card.querySelector('.preview-state');
    try {
      const r = await api.sources.test(src.id);
      const working = r.status === 'ok';
      card.dataset.preview = working ? 'working' : 'offline';
      stateEl.textContent = working ? 'live' : (r.status === 'no_publisher' ? 'no signal' : r.status);
      stateEl.dataset.state = working ? 'ok' : 'warn';
      card.querySelector('.packet-age').textContent = working ? 'recent' : '—';
    } catch {
      card.dataset.preview = 'offline';
      stateEl.textContent = 'offline'; stateEl.dataset.state = 'err';
    }
  }

  function startPreviewPolling() {
    if (previewPoll) clearInterval(previewPoll);
    const cards = Array.from($('previewGrid').children);
    sources.forEach((src, i) => pollPreviewState(src, cards[i]));
    previewPoll = setInterval(() => {
      const cards = Array.from($('previewGrid').children);
      sources.forEach((src, i) => pollPreviewState(src, cards[i]));
    }, 5000);
  }

  // ---- mark play ----
  function renderMarkBar() {
    const btn = $('markPlayBtn');
    // Disabled ONLY when the game is not live (not when a source is offline).
    btn.disabled = currentGame.status !== 'live';
    const pre = (serverSettings && serverSettings.defaultPreRollMs) ?? 18000;
    const post = (serverSettings && serverSettings.defaultPostRollMs) ?? 3000;
    $('captureHint').textContent = `pre-roll ${pre / 1000}s · post-roll ${post / 1000}s`;
  }

  async function markPlay() {
    const btn = $('markPlayBtn');
    btn.disabled = true;
    const status = $('markStatus');
    status.textContent = 'marking…'; status.dataset.state = '';
    // Idempotency key: reuse within a short window so a retry/timeout doesn't
    // double-mark. New key per deliberate press.
    lastIdempotencyKey = `mark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const play = await api.plays.mark(currentGame.id, {}, lastIdempotencyKey);
      status.textContent = `Play ${play.playNumber} marked`; status.dataset.state = 'ok';
      await refreshRecent();
    } catch (err) {
      status.textContent = `mark failed: ${err.message}`; status.dataset.state = 'error';
      // Retry the SAME idempotency key on timeout/network error (server
      // dedupes), after a short delay.
      if (err.status === 408 || err.code === 'http_error' || err.status >= 500) {
        setTimeout(() => { retryMark(lastIdempotencyKey); }, 1500);
      }
    } finally {
      btn.disabled = currentGame.status !== 'live';
    }
  }

  async function retryMark(key) {
    const status = $('markStatus');
    status.textContent = 'retrying mark…';
    try {
      const play = await api.plays.mark(currentGame.id, {}, key);
      status.textContent = `Play ${play.playNumber} marked`; status.dataset.state = 'ok';
      await refreshRecent();
    } catch (err) {
      status.textContent = `mark failed: ${err.message}`; status.dataset.state = 'error';
    }
  }

  // ---- recent plays ----
  async function refreshRecent() {
    const list = await api.plays.list(currentGame.id);
    const ul = $('recentList');
    ul.innerHTML = '';
    $('recentEmpty').hidden = list.length > 0;
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.dataset.playId = p.id;
      li.innerHTML = `<span class="pn">#${p.playNumber}</span>
        <span class="angles" id="angles-${p.id}"></span>`;
      ul.appendChild(li);
      renderAngles(p.id, p.angles || []);
    }
  }

  function renderAngles(playId, angles) {
    const el = $('angles-' + playId);
    if (!el) return;
    el.innerHTML = '';
    for (const a of angles) {
      const chip = document.createElement('span');
      chip.className = 'angle-chip';
      chip.dataset.angleId = a.id;
      chip.dataset.status = a.status;
      chip.textContent = `${a.sourceKey || a.source_key || '?'}: ${a.status}`;
      el.appendChild(chip);
    }
  }

  // ---- events ----
  function startEvents() {
    eventClient = window.EventClient.create({
      gameId: currentGame.id,
      onEvent: (ev) => {
        if (ev.type === 'play.angle.updated') {
          // Update the chip for this angle, then refresh the play's angles
          // to pick up the authoritative row.
          const chip = document.querySelector(`.angle-chip[data-angle-id="${ev.angleId}"]`);
          if (chip && ev.payload) {
            chip.dataset.status = ev.payload.status;
            chip.textContent = `${chip.textContent.split(':')[0]}: ${ev.payload.status}`;
          }
          refreshRecent();
        }
      },
      onStatus: (state) => {
        const el = $('networkStatus');
        el.dataset.state = state;
        el.textContent = `network: ${state}`;
      },
    });
    eventClient.start();
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- wire up ----
  function init() {
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('loginError'); err.hidden = true;
      try {
        await fetch(api.BASE + '/auth/csrf', { credentials: 'same-origin' }); api.primeCsrf();
        await login($('loginEmail').value, $('loginPassword').value);
        $('loginGate').hidden = true; $('liveMain').hidden = false;
        await bootstrap();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    $('gameSelect').addEventListener('change', (e) => selectGame(e.target.value));
    $('startGameBtn').addEventListener('click', async () => { await api.games.start(currentGame.id); await selectGame(currentGame.id); });
    $('endGameBtn').addEventListener('click', async () => { await api.games.end(currentGame.id); await selectGame(currentGame.id); });
    $('markPlayBtn').addEventListener('click', () => { clearTimeout(markDebounce); markDebounce = setTimeout(markPlay, 250); });

    // Try to bootstrap with an existing session.
    fetch(api.BASE + '/auth/csrf', { credentials: 'same-origin' }).then(() => {
      api.primeCsrf();
      api.auth.me().then((m) => { if (m) { $('loginGate').hidden = true; bootstrap(); } }).catch(() => {});
    });
  }
  document.addEventListener('DOMContentLoaded', init);
  window.FilmRoomLive = { selectGame, refreshRecent }; // for E2E hooks
})();
