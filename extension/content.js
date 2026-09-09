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

  let lastPlayNumber; // undefined until first real read, so the initial report always fires

  function reportNow() {
    const fields = currentPlayFields();
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
