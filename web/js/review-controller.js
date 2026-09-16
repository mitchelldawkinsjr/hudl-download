// Film Room Review controller (Phase 5). Vanilla JS, reuses TelestrationPlayer
// from shared/player.js. Loads a play's angles, renders angle tabs per
// assigned source, plays a single angle's server clip, and preserves
// logical time when switching angles (seeks to logicalTime + syncOffsetMs,
// never resets to zero). Missing angles show a specific status, not a broken
// player. Metadata edits are optimistic with version-conflict resolution.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.FilmRoomAPI;

  let me = null;
  let games = [];
  let currentGame = null;
  let plays = [];
  let currentPlay = null;
  let angles = [];
  let currentAngleId = null;
  let player = null;
  let logicalTimeMs = 0; // captured across angle switches
  let dirtyMeta = null;  // unsaved user edits

  function getCookie(name) { const m = document.cookie.match('(?:^|; )' + name + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }

  async function login(email, password) {
    const r = await fetch(api.BASE + '/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': getCookie('csrf') || '' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error((await r.json()).error?.message || 'login failed');
    api.primeCsrf();
  }

  async function bootstrap() {
    me = await api.auth.me();
    if (!me) { showLogin(); return; }
    games = await api.games.list();
    renderGameSelect();
    if (games.length) await selectGame(games[0].id);
    $('reviewMain').hidden = false;
  }

  function renderGameSelect() {
    const sel = $('gameSelect'); sel.innerHTML = '';
    for (const g of games) {
      const o = document.createElement('option'); o.value = g.id;
      o.textContent = `${g.opponent} (${g.status})`;
      sel.appendChild(o);
    }
  }

  async function selectGame(id) {
    currentGame = await api.games.get(id);
    plays = await api.plays.list(id);
    renderPlaySelect();
    if (plays.length) await selectPlay(plays[0].id);
    else { currentPlay = null; angles = []; renderAngles(); }
  }

  function renderPlaySelect() {
    const sel = $('playSelect'); sel.innerHTML = '';
    for (const p of plays) {
      const o = document.createElement('option'); o.value = p.id;
      o.textContent = `#${p.playNumber} (${p.status})`;
      sel.appendChild(o);
    }
  }

  async function selectPlay(id) {
    currentPlay = await api.plays.get(id);
    angles = currentPlay.angles || [];
    logicalTimeMs = 0;
    dirtyMeta = null;
    renderMeta();
    renderAngles();
    // Auto-select first ready angle (else first).
    const first = angles.find((a) => a.status === 'ready') || angles[0];
    if (first) await selectAngle(first.id);
  }

  function renderMeta() {
    if (!currentPlay) return;
    $('metaQuarter').value = currentPlay.quarter ?? '';
    $('metaGameClock').value = currentPlay.gameClock ?? '';
    $('metaNotes').value = currentPlay.notes ?? '';
    $('versionTag').textContent = `v${currentPlay.version}`;
    $('metaStatus').textContent = ''; $('metaStatus').dataset.state = '';
  }

  function renderAngles() {
    const tabs = $('angleTabs'); tabs.innerHTML = '';
    for (const a of angles) {
      const t = document.createElement('button');
      t.className = 'angle-tab';
      t.dataset.angleId = a.id;
      t.dataset.status = a.status;
      t.textContent = `${a.sourceKey || a.source_key || '?'} · ${a.status}`;
      t.addEventListener('click', () => selectAngle(a.id));
      tabs.appendChild(t);
    }
    // Side by Side tab (Phase 6): enabled only when >=2 ready angles.
    const ready = angles.filter((a) => a.status === 'ready');
    if (angles.length >= 2) {
      const t = document.createElement('button');
      t.className = 'angle-tab';
      t.dataset.angleId = '__sbs__';
      t.dataset.disabled = String(ready.length < 2);
      t.textContent = ready.length < 2 ? 'Side by Side (needs 2 ready)' : 'Side by Side';
      t.addEventListener('click', () => selectSideBySide());
      tabs.appendChild(t);
    }
  }

  async function selectSideBySide() {
    currentAngleId = '__sbs__';
    document.querySelectorAll('.angle-tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.angleId === '__sbs__'));
    });
    const ready = angles.filter((a) => a.status === 'ready');
    if (ready.length < 2) { showPlaceholder('missing', 'Side by Side needs two ready angles.'); return; }
    $('playerWrap').hidden = true;
    $('sbsWrap').hidden = false;
    window.SideBySide.build($('sbsGrid'), currentPlay.id, ready);
    window.SideBySide.show();
  }

  async function selectAngle(angleId) {
    currentAngleId = angleId;
    // Mark active tab.
    document.querySelectorAll('.angle-tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.angleId === angleId));
    });
    const a = angles.find((x) => x.id === angleId);
    if (!a) return;
    // Single-angle view: hide side-by-side, show the single player.
    $('sbsWrap').hidden = true;
    $('playerWrap').hidden = false;
    if (window.SideBySide) window.SideBySide.hide();

    if (a.status !== 'ready') {
      // Missing-angle UX: specific status, no broken player.
      showPlaceholder(a.status, angleStatusMessage(a));
      return;
    }
    // Ready: load the server clip into the player.
    $('placeholder').hidden = true;
    $('video').style.display = '';
    if (!player) player = new TelestrationPlayer({ video: $('video'), canvas: $('overlay') });
    const url = `/api/v1/plays/${currentPlay.id}/angles/${a.id}/clip`;
    // Capture logical time before swapping the source.
    logicalTimeMs = Math.round(($('video').currentTime || 0) * 1000);
    player.load(url);
    // Seek to the captured logical time + this angle's sync offset (continuity).
    const targetSec = logicalTimeMs / 1000 + (a.syncOffsetMs || 0) / 1000;
    $('video').addEventListener('loadedmetadata', function onMeta() {
      $('video').removeEventListener('loadedmetadata', onMeta);
      if (targetSec > 0 && targetSec < ($('video').duration || Infinity)) {
        $('video').currentTime = targetSec;
      }
    });
  }

  function showPlaceholder(status, msg) {
    const p = $('placeholder');
    p.hidden = false;
    p.dataset.status = status;
    p.textContent = msg;
    $('video').style.display = 'none';
  }

  function angleStatusMessage(a) {
    switch (a.status) {
      case 'processing': return 'Clip is still processing — check back shortly.';
      case 'queued': return 'Clip is queued for processing.';
      case 'missing': return `No recording for this angle${a.errorCode ? ` (${a.errorCode})` : ''}.`;
      case 'failed': return `Clip failed${a.errorMessage ? `: ${a.errorMessage}` : ''}.`;
      default: return 'Angle not available.';
    }
  }

  // ---- metadata edit (optimistic + version-conflict resolution) ----
  function captureDirty() {
    if (!currentPlay) return;
    dirtyMeta = {
      quarter: $('metaQuarter').value === '' ? null : parseInt($('metaQuarter').value, 10),
      gameClock: $('metaGameClock').value || null,
      notes: $('metaNotes').value || null,
    };
  }

  async function saveMeta() {
    if (!currentPlay) return;
    captureDirty();
    const status = $('metaStatus');
    status.textContent = 'saving…'; status.dataset.state = '';
    try {
      const updated = await api.plays.patch(currentPlay.id, {
        version: currentPlay.version, ...dirtyMeta,
      });
      currentPlay = updated;
      $('versionTag').textContent = `v${updated.version}`;
      status.textContent = 'saved'; status.dataset.state = 'ok';
      dirtyMeta = null;
    } catch (err) {
      if (err.status === 409) {
        // Version conflict: reload the server version, preserve unsaved user
        // values, and ask the user to resolve.
        const server = await api.plays.get(currentPlay.id);
        currentPlay = server;
        // Preserve the user's unsaved edits (don't clobber with server values).
        if (dirtyMeta.quarter != null) $('metaQuarter').value = dirtyMeta.quarter ?? '';
        if (dirtyMeta.gameClock != null) $('metaGameClock').value = dirtyMeta.gameClock ?? '';
        if (dirtyMeta.notes != null) $('metaNotes').value = dirtyMeta.notes ?? '';
        $('versionTag').textContent = `v${server.version} (conflict — review and save again)`;
        status.textContent = 'conflict — server version loaded, your edits kept'; status.dataset.state = 'error';
      } else {
        status.textContent = `save failed: ${err.message}`; status.dataset.state = 'error';
      }
    }
  }

  // ---- wire up ----
  function init() {
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('loginError'); err.hidden = true;
      try {
        await fetch(api.BASE + '/auth/csrf', { credentials: 'same-origin' }); api.primeCsrf();
        await login($('loginEmail').value, $('loginPassword').value);
        $('loginGate').hidden = true; $('reviewMain').hidden = false;
        await bootstrap();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    $('gameSelect').addEventListener('change', (e) => selectGame(e.target.value));
    $('playSelect').addEventListener('change', (e) => selectPlay(e.target.value));
    $('saveMetaBtn').addEventListener('click', saveMeta);
    ['metaQuarter', 'metaGameClock', 'metaNotes'].forEach((id) => {
      $(id).addEventListener('input', captureDirty);
    });
    if (window.SideBySide) window.SideBySide.init();

    fetch(api.BASE + '/auth/csrf', { credentials: 'same-origin' }).then(() => {
      api.primeCsrf();
      api.auth.me().then((m) => { if (m) { $('loginGate').hidden = true; bootstrap(); } }).catch(() => {});
    });
  }
  document.addEventListener('DOMContentLoaded', init);
  window.FilmRoomReview = { selectGame, selectPlay }; // for E2E hooks
})();
