// Side by side controller (Phase 6). Builds a MultiAnglePlayer for two
// ready angles, wires shared controls, the sync-offset control (stored on
// play_angle.sync_offset_ms, persists on reload), and side-by-side
// telestration (draw on Drone / Press Box / Both; active canvas has a
// visible border + a11y label). Timestamps are logical play time.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.FilmRoomAPI;

  let player = null;
  let playId = null;
  let angles = [];        // the two ready angles [{id, sourceKey, syncOffsetMs}]
  let videoEls = [];
  let canvasEls = [];
  let drawTarget = '0';   // '0' | '1' | 'both'
  let drawing = false;
  let lastPt = null;

  function build(grid, aPlayId, aAngles) {
    playId = aPlayId;
    angles = aAngles;
    grid.innerHTML = '';
    videoEls = [];
    canvasEls = [];
    for (const a of angles) {
      const cell = document.createElement('div');
      cell.className = 'sbs-cell';
      const v = document.createElement('video');
      v.playsInline = true; v.muted = true; v.src = `/api/v1/plays/${playId}/angles/${a.id}/clip`;
      const c = document.createElement('canvas');
      c.className = 'sbs-canvas';
      c.setAttribute('aria-label', `Telestration overlay for ${a.sourceKey || a.source_key || 'angle'}`);
      cell.appendChild(v); cell.appendChild(c);
      grid.appendChild(cell);
      videoEls.push(v); canvasEls.push(c);
    }
    if (!player) player = window.MultiAnglePlayer.create();
    player.attach({ videos: videoEls, canvases: canvasEls });
    player.setOffsets(angles.map((a) => a.syncOffsetMs || 0));
    wireDraw();
  }

  function show() { $('sbsWrap').hidden = false; }
  function hide() { if (player) player.destroy(); $('sbsWrap').hidden = true; }

  function wireControls() {
    $('sbsPlay').onclick = () => player.play();
    $('sbsPause').onclick = () => player.pause();
    $('sbsBack5').onclick = () => player.seekBy(-5);
    $('sbsFwd5').onclick = () => player.seekBy(5);
    $('sbsSpeed').onchange = (e) => player.setSpeed(parseFloat(e.target.value));
    $('sbsSaveOffset').onclick = saveOffset;
    document.querySelectorAll('input[name="sbsDraw"]').forEach((r) => {
      r.onchange = (e) => { drawTarget = e.target.value; updateActiveBorders(); };
    });
  }

  async function saveOffset() {
    const ms = parseInt($('sbsOffset').value, 10) || 0;
    const status = $('sbsStatus');
    status.textContent = 'saving…'; status.dataset.state = '';
    try {
      // Store the offset on the follower (second) angle.
      const follower = angles[1];
      if (!follower) throw new Error('no follower angle');
      await api.plays.syncAngle(follower.id, ms);
      player.setOffsets([0, ms]);
      status.textContent = 'offset saved'; status.dataset.state = 'ok';
    } catch (err) {
      status.textContent = `save failed: ${err.message}`; status.dataset.state = 'error';
    }
  }

  // ---- side-by-side telestration ----
  function wireDraw() {
    canvasEls.forEach((c, i) => {
      c.onpointerdown = (e) => { if (isDrawable(i)) { drawing = true; lastPt = pt(c, e); } };
      c.onpointermove = (e) => { if (drawing && isDrawable(i)) { draw(c, lastPt, pt(c, e)); lastPt = pt(c, e); } };
      c.onpointerup = () => { drawing = false; lastPt = null; };
    });
    updateActiveBorders();
  }
  function isDrawable(i) { return drawTarget === 'both' || drawTarget === String(i); }
  function updateActiveBorders() {
    canvasEls.forEach((c, i) => {
      const active = isDrawable(i);
      c.classList.toggle('active', active);
      c.setAttribute('aria-disabled', String(!active));
    });
  }
  function pt(c, e) { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
  function draw(c, a, b) {
    const ctx = c.getContext('2d'); if (!ctx) return;
    if (c.width !== c.clientWidth) { c.width = c.clientWidth; c.height = c.clientHeight; }
    ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x * c.width, a.y * c.height); ctx.lineTo(b.x * c.width, b.y * c.height); ctx.stroke();
  }

  function init() { if ($('sbsPlay')) wireControls(); }

  window.SideBySide = { build, show, hide, init };
})();
