// Film Room — Settings → Video Sources controller (Phase 2).
// Vanilla JS (ADR 0002). Drives the admin screen: login gate, MediaMTX server
// config, source CRUD, connection test + live preview, publishing settings,
// and game assignment + order. All state is backend-persisted, so a refresh
// restores everything (refresh-persists guarantee).
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.FilmRoomAPI;

  // ---- view state ----
  let teamId = null;
  let sources = [];          // team-scoped reusable sources
  let games = [];
  let currentGameId = null;
  let currentGameSources = []; // { sourceId, sortOrder } for the selected game
  let editingSourceId = null;
  let dialogSource = null;
  let streamKeyRevealed = false;

  // ---- helpers ----
  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
  function setStatus(el, msg, kind) {
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function showError(el, msg) { el.textContent = msg; el.className = 'error'; show(el); }
  function clearError(el) { el.textContent = ''; hide(el); }

  const TEST_LABELS = {
    ok: '✓ Connected — publisher live',
    server_unreachable: '✗ Server unreachable',
    no_publisher: '○ No publisher on this path',
    auth_failed: '✗ Authentication failed',
    playback_failed: '✗ Playback failed',
  };

  // ---- auth gate ----
  async function bootstrap() {
    try {
      // Prime the CSRF cookie with a harmless GET.
      await api.auth.me();
      api.primeCsrf();
      await enterAdmin();
    } catch {
      show($('loginGate'));
    }
  }

  async function loginSubmit(e) {
    e.preventDefault();
    clearError($('loginError'));
    try {
      await api.auth.login($('loginEmail').value, $('loginPassword').value);
      api.primeCsrf();
      hide($('loginGate'));
      await enterAdmin();
    } catch (err) {
      showError($('loginError'), err.message || 'Sign-in failed');
    }
  }

  async function enterAdmin() {
    const me = await api.auth.me();
    $('whoami').textContent = `${me.email} · ${me.role}`;
    show($('whoami')); show($('logoutBtn'));
    show($('settingsMain'));
    teamId = (me.teamIds && me.teamIds[0]) || null;
    await Promise.all([loadServerSettings(), loadSources(), loadGames()]);
  }

  async function logout() {
    try { await api.auth.logout(); } catch {}
    location.reload();
  }

  // ---- (a) MediaMTX server ----
  async function loadServerSettings() {
    try {
      const s = await api.settings.get();
      if (!s) return;
      $('publicPlaybackBase').value = s.publicPlaybackBase || '';
      $('privateApiBase').value = s.privateApiBase || '';
      $('privatePlaybackBase').value = s.privatePlaybackBase || '';
      $('webrtcPublicBase').value = s.webrtcPublicBase || '';
      $('hlsPublicBase').value = s.hlsPublicBase || '';
      $('rtmpHost').value = s.rtmpHost || '';
      $('rtmpPort').value = s.rtmpPort || 1935;
    } catch (err) {
      setStatus($('serverStatus'), 'Could not load server settings: ' + err.message, 'err');
    }
  }

  async function saveServer() {
    const s = {
      publicPlaybackBase: $('publicPlaybackBase').value || null,
      privateApiBase: $('privateApiBase').value || null,
      privatePlaybackBase: $('privatePlaybackBase').value || null,
      webrtcPublicBase: $('webrtcPublicBase').value || null,
      hlsPublicBase: $('hlsPublicBase').value || null,
      rtmpHost: $('rtmpHost').value || null,
      rtmpPort: parseInt($('rtmpPort').value, 10) || 1935,
    };
    setStatus($('serverStatus'), 'Saving…');
    try {
      await api.settings.put(s);
      setStatus($('serverStatus'), 'Saved', 'ok');
    } catch (err) {
      setStatus($('serverStatus'), 'Save failed: ' + (err.message || err.code), 'err');
    }
  }

  // ---- (b) sources CRUD ----
  async function loadSources() {
    try {
      sources = await api.sources.list(teamId);
      renderSources();
    } catch (err) {
      showError($('sourceFormError'), 'Could not load sources: ' + (err.message || err.code));
    }
  }

  function renderSources() {
    const list = $('sourceList');
    list.innerHTML = '';
    if (!sources.length) {
      list.innerHTML = '<li class="muted">No sources yet. Add your first camera above.</li>';
      return;
    }
    sources.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'source-item';
      li.innerHTML =
        `<span class="name"></span><span class="path"></span>` +
        `<span class="badge ${s.active ? '' : 'inactive'}">${s.active ? 'active' : 'disabled'}</span>` +
        `<span class="spacer"></span>` +
        `<button class="btn tiny" data-act="test">Test / preview</button>` +
        `<button class="btn tiny" data-act="edit">Edit</button>` +
        `<button class="btn tiny" data-act="delete">Delete</button>`;
      li.querySelector('.name').textContent = s.displayName;
      li.querySelector('.path').textContent = `/${s.mediamtxPath} · ${s.previewProtocol}`;
      li.querySelector('[data-act="test"]').onclick = () => openSourceDialog(s);
      li.querySelector('[data-act="edit"]').onclick = () => startEdit(s);
      li.querySelector('[data-act="delete"]').onclick = () => deleteSource(s);
      list.appendChild(li);
    });
  }

  function startEdit(s) {
    editingSourceId = s.id;
    $('sourceId').value = s.id;
    $('displayName').value = s.displayName;
    $('sourceKey').value = s.key;
    $('mediamtxPath').value = s.mediamtxPath;
    $('previewProtocol').value = s.previewProtocol;
    $('playbackUrlOverride').value = s.playbackUrlOverride || '';
    $('sourceSortOrder').value = s.sortOrder;
    $('sourceSubmitBtn').textContent = 'Save source';
    show($('sourceCancelBtn'));
    $('displayName').focus();
  }

  function cancelEdit() {
    editingSourceId = null;
    $('sourceForm').reset();
    $('sourceId').value = '';
    $('sourceSubmitBtn').textContent = 'Add source';
    hide($('sourceCancelBtn'));
    clearError($('sourceFormError'));
  }

  async function sourceSubmit(e) {
    e.preventDefault();
    clearError($('sourceFormError'));
    const body = {
      teamId,
      gameId: null,
      key: $('sourceKey').value,
      displayName: $('displayName').value,
      mediamtxPath: $('mediamtxPath').value,
      previewProtocol: $('previewProtocol').value,
      playbackUrlOverride: $('playbackUrlOverride').value || null,
      sortOrder: parseInt($('sourceSortOrder').value, 10) || 0,
      active: true,
    };
    try {
      if (editingSourceId) {
        await api.sources.update(editingSourceId, {
          displayName: body.displayName, mediamtxPath: body.mediamtxPath,
          previewProtocol: body.previewProtocol, playbackUrlOverride: body.playbackUrlOverride,
          sortOrder: body.sortOrder,
        });
      } else {
        await api.sources.create(body);
      }
      cancelEdit();
      await loadSources();
      await refreshAssignmentList();
    } catch (err) {
      showError($('sourceFormError'), (err.details && err.details.formErrors) || err.message || err.code);
    }
  }

  async function deleteSource(s) {
    if (!confirm(`Delete source "${s.displayName}"? This cannot be undone.`)) return;
    try {
      await api.sources.remove(s.id);
      await loadSources();
      await refreshAssignmentList();
    } catch (err) {
      alert('Delete failed: ' + (err.message || err.code));
    }
  }

  // ---- (c) source dialog: test + preview + publishing ----
  async function openSourceDialog(s) {
    dialogSource = s;
    streamKeyRevealed = false;
    $('sourceDialogTitle').textContent = `${s.displayName} · /${s.mediamtxPath}`;
    $('testStatus').textContent = 'Not tested yet';
    $('testStatus').removeAttribute('data-state');
    $('previewPlaceholder').hidden = false;
    $('previewVideo').src = '';
    $('pubServerUrl').value = '';
    $('pubStreamKey').value = '';
    $('pubCombinedUrl').value = '';
    $('sourceDialog').showModal();
    // Load publishing settings immediately.
    try {
      const pub = await api.sources.publishing(s.id, currentGameId);
      $('pubServerUrl').value = pub.serverUrl;
      $('pubStreamKey').value = pub.maskedStreamKey;
      $('pubCombinedUrl').value = pub.combinedUrl;
      $('pubStreamKey').dataset.full = pub.streamKey;
    } catch (err) {
      $('pubStreamKey').value = 'Could not load: ' + (err.message || err.code);
    }
  }

  async function runTest() {
    if (!dialogSource) return;
    $('testStatus').textContent = 'Testing…';
    $('testStatus').removeAttribute('data-state');
    try {
      const r = await api.sources.test(dialogSource.id);
      $('testStatus').textContent = TEST_LABELS[r.status] || r.status;
      $('testStatus').setAttribute('data-state', r.status);
      if (r.status === 'ok') startPreview(dialogSource);
    } catch (err) {
      $('testStatus').textContent = 'Test failed: ' + (err.message || err.code);
      $('testStatus').setAttribute('data-state', 'server_unreachable');
    }
  }

  // Resolve the browser-facing playback URL for a source: override first,
  // else protocol + public base + path. Native HLS is used here; hls.js /
  // WHEP are extension points (see plan Phase 2 §7).
  function resolvePreviewUrl(source) {
    if (source.playbackUrlOverride) return source.playbackUrlOverride;
    const base = source.previewProtocol === 'webrtc'
      ? $('webrtcPublicBase').value
      : ($('hlsPublicBase').value || $('publicPlaybackBase').value);
    if (!base) return null;
    const u = new URL(base);
    // HLS: /games/{gameId}/{path}/index.m3u8 or /{path}/index.m3u8
    if (source.previewProtocol === 'hls') {
      u.pathname = u.pathname.replace(/\/$/, '') +
        (currentGameId ? `/games/${currentGameId}/${source.mediamtxPath}` : `/${source.mediamtxPath}`) +
        '/index.m3u8';
      return u.toString();
    }
    // WebRTC (WHEP) — extension point; not wired in the MVP UI.
    return null;
  }

  function startPreview(source) {
    const url = resolvePreviewUrl(source);
    const v = $('previewVideo');
    if (!url) {
      $('previewPlaceholder').textContent = 'No public playback base configured. Set one in MediaMTX Server above.';
      $('previewPlaceholder').hidden = false;
      return;
    }
    $('previewPlaceholder').hidden = true;
    v.src = url;
    v.play().catch(() => {/* autoplay may need a gesture; muted helps */});
  }

  function toggleRevealStreamKey() {
    const input = $('pubStreamKey');
    streamKeyRevealed = !streamKeyRevealed;
    input.value = streamKeyRevealed ? (input.dataset.full || '') : (input.dataset.masked || input.value);
  }

  function copyField(id) {
    const el = $(id);
    // For the stream key, copy the full value even when masked.
    const val = id === 'pubStreamKey' ? (el.dataset.full || el.value) : el.value;
    navigator.clipboard.writeText(val).then(() => {
      const btn = document.querySelector(`[data-copy="${id}"]`);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = orig), 1200);
    });
  }

  // ---- (d) game assignment + order ----
  async function loadGames() {
    try {
      games = await api.games.list();
      const sel = $('assignGameSelect');
      sel.innerHTML = '<option value="">Select a game…</option>' +
        games.map((g) => `<option value="${g.id}">${g.opponent} (${g.status})</option>`).join('');
      if (currentGameId) sel.value = currentGameId;
    } catch (err) {
      $('assignGameSelect').innerHTML = '<option value="">No games available</option>';
    }
  }

  async function onGameSelect() {
    currentGameId = $('assignGameSelect').value || null;
    await refreshAssignmentList();
  }

  async function refreshAssignmentList() {
    const list = $('assignList');
    list.innerHTML = '';
    if (!currentGameId) {
      list.innerHTML = '<li class="muted">Select a game to assign sources.</li>';
      currentGameSources = [];
      return;
    }
    try {
      const assigned = await api.games.sources(currentGameId);
      currentGameSources = assigned.map((a) => ({ sourceId: a.id, sortOrder: a.sortOrder }));
      // Render all team sources with checkboxes + order; pre-check assigned.
      if (!sources.length) await loadSources();
      if (!sources.length) {
        list.innerHTML = '<li class="muted">No sources configured. Add cameras in the Camera Sources section above.</li>';
        return;
      }
      sources.forEach((s) => {
        const assignedRow = currentGameSources.find((a) => a.sourceId === s.id);
        const li = document.createElement('li');
        li.className = 'assign-item';
        li.innerHTML =
          `<input type="checkbox" data-id="${s.id}" ${assignedRow ? 'checked' : ''}>` +
          `<span class="name">${s.displayName}</span><span class="path">/${s.mediamtxPath}</span>` +
          `<span class="spacer"></span>` +
          `<label class="field">order <input type="number" min="0" data-order="${s.id}" value="${assignedRow ? assignedRow.sortOrder : 0}" style="width:64px"></label>`;
        li.querySelector('input[type=checkbox]').onchange = syncAssignment;
        li.querySelector('[data-order]').oninput = syncAssignment;
        list.appendChild(li);
      });
    } catch (err) {
      list.innerHTML = `<li class="muted">Could not load assignment: ${err.message || err.code}</li>`;
    }
  }

  function syncAssignment() {
    // Rebuild currentGameSources from the checkboxes + order inputs.
    const items = [...$('assignList').querySelectorAll('.assign-item')];
    currentGameSources = items
      .map((li) => {
        const cb = li.querySelector('input[type=checkbox]');
        const order = li.querySelector('[data-order]');
        return { sourceId: cb.dataset.id, sortOrder: parseInt(order.value, 10) || 0, checked: cb.checked };
      })
      .filter((a) => a.checked)
      .map(({ sourceId, sortOrder }) => ({ sourceId, sortOrder }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async function saveAssignment() {
    if (!currentGameId) { setStatus($('assignStatus'), 'Select a game first', 'err'); return; }
    setStatus($('assignStatus'), 'Saving…');
    try {
      await api.games.assign(currentGameId, currentGameSources);
      setStatus($('assignStatus'), 'Saved', 'ok');
      await refreshAssignmentList();
    } catch (err) {
      setStatus($('assignStatus'), 'Save failed: ' + (err.message || err.code), 'err');
    }
  }

  // ---- wire up ----
  // Expose a small hook for E2E/tests to refresh the games dropdown after a
  // game is created out-of-band (no game-create UI on this screen).
  window.FilmRoomSettings = { reloadGames: loadGames };

  function init() {
    $('loginForm').addEventListener('submit', loginSubmit);
    $('logoutBtn').addEventListener('click', logout);
    $('saveServerBtn').addEventListener('click', saveServer);
    $('sourceForm').addEventListener('submit', sourceSubmit);
    $('sourceCancelBtn').addEventListener('click', cancelEdit);
    $('testBtn').addEventListener('click', runTest);
    $('assignGameSelect').addEventListener('change', onGameSelect);
    $('saveAssignmentBtn').addEventListener('click', saveAssignment);
    document.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.copy === 'pubStreamKey') toggleRevealStreamKey();
        copyField(b.dataset.copy);
      })
    );
    bootstrap();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
