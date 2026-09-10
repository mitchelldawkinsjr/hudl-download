// Runs continuously in the page (not just once, like the chrome.scripting
// calls elsewhere) to watch Hudl's per-clip data fields in real time and
// report the currently-active play to the background service worker the
// instant it changes.
//
// Why this exists: correlating a downloaded stream to "which play is this"
// by position (the Nth network request <-> the Nth row in the play-by-play
// grid) is only an assumption -- it breaks if a play requests more than one
// camera angle (two stream detections consumed for one grid row, throwing
// off every play after it) or if plays are viewed out of order. Watching
// the DOM live and tagging each stream with whatever the toolbar actually
// said at the moment its request fired isn't a positional guess -- it's
// reading the same field the toolbar itself is driven by, at the moment
// that matters.
(function () {
  function currentPlayFields() {
    const fields = {};
    document.querySelectorAll('[data-qa-id^="clip-preview-"][data-qa-id$="-field"]').forEach((el) => {
      const qa = el.getAttribute('data-qa-id') || '';
      const name = qa.replace(/^clip-preview-/, '').replace(/-field$/, '');
      const kids = el.children;
      if (!name || kids.length < 2) return;
      const value = (kids[1].textContent || '').trim();
      if (value && value !== '-') fields[name] = value.slice(0, 200);
    });
    return fields;
  }

  // The play-by-play grid's currently-selected row -- a second, independent
  // real-time signal for "which play is loaded". The toolbar above the video
  // only ever describes the one clip loaded in the player; the grid's
  // selected row carries the SAME play's full row (DN, DIST, RESULT, QTR,
  // ...) and stays in sync with the table the downloader saves, so the
  // snapshot we tag each stream with is a complete play-by-play row, not
  // just the toolbar's handful of fields. ag-Grid marks the active row with
  // aria-selected="true"; we fall back to ag-grid's selectable classes if
  // Hudl's build doesn't set the aria attribute.
  function currentGridRowFields() {
    const grid = document.querySelector('[data-qa-id="ag-grid"]');
    if (!grid) return {};
    let rowEl = grid.querySelector('[role="row"][aria-selected="true"]');
    if (!rowEl) rowEl = grid.querySelector('[role="row"].ag-row-selected, [role="row"].ag-row-focus');
    // ag-Grid's own API markers above assume Hudl uses stock ag-Grid state
    // to flag the active row. In practice Hudl's build marks it with its
    // own CSS-module class instead -- confirmed against a real rendered
    // page as something like "_focused-row_1ixyw_1" (every row's
    // aria-selected stayed "false", and none had ag-row-selected/
    // ag-row-focus, so the two lookups above always missed and this
    // function silently returned {} every time). That hash suffix is
    // build-specific and will change across Hudl deploys, so match on the
    // stable "focused-row" fragment via a substring selector instead of
    // the exact class.
    if (!rowEl) rowEl = grid.querySelector('[role="row"][class*="focused-row"]');
    if (!rowEl) return {};
    const headerByColId = {};
    grid.querySelectorAll('[role="columnheader"][col-id]').forEach((h) => {
      const colId = h.getAttribute('col-id');
      const text = (h.textContent || '').trim();
      if (colId && text) headerByColId[colId] = text;
    });
    const fields = {};
    rowEl.querySelectorAll('[role="gridcell"][col-id]').forEach((cell) => {
      const name = headerByColId[cell.getAttribute('col-id')];
      const value = (cell.textContent || '').trim();
      if (name && value && value !== '-') fields[name] = value.slice(0, 200);
    });
    return fields;
  }

  let lastPlayNumber; // undefined until first real read, so the initial report always fires

  function reportNow() {
    // Grid-row first, then toolbar overrides -- the toolbar is the canonical
    // "currently loaded clip" source, but the grid row supplies the full
    // play-by-play fields the toolbar omits. PLAY # should agree in both.
    const fields = { ...currentGridRowFields(), ...currentPlayFields() };
    const playNumber = fields['PLAY #'] || null;
    // Only send when the play number actually changed -- most DOM
    // mutations on the page have nothing to do with which play is active,
    // and re-sending the same value on every one of them would flood the
    // background worker with messages for no benefit. Deliberately NOT
    // debounced/delayed: the whole point is to catch the change as close
    // as possible to when it happens, since a video request can follow
    // within milliseconds.
    if (playNumber === lastPlayNumber) return;
    lastPlayNumber = playNumber;
    chrome.runtime.sendMessage({ type: 'current-play', playNumber, fields, time: Date.now() }).catch(() => {});
  }

  new MutationObserver(reportNow).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // Safety net: catches any change a mutation observer might miss (e.g. a
  // style-only re-render that swaps text via a mechanism that doesn't
  // trigger childList/characterData records in a detectable way).
  setInterval(reportNow, 1000);
  reportNow();
})();
