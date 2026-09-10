// Shared between background.js (via importScripts) and popup.js (via a
// <script> tag) -- naming/date-folder utilities, the walk's tiny
// concurrency semaphore, and the page-interaction functions that get
// injected into the Hudl tab via chrome.scripting.executeScript. Kept in
// one file, loaded by both, so the two contexts use the exact same logic
// instead of two copies quietly drifting apart. Classic (non-module)
// scripts share one global scope with whatever loads after them, which is
// what makes this work in both a service worker and a popup document.

function slugify(s) {
  return (s || 'clip').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
}

// mm-dd-yyyy_HH-mm -- "/" can't be used between the date parts the way a
// literal mm/dd/yyyy would (it's a path separator; it would silently
// create nested folders, not one folder named that), so this uses "-"
// there. The time separator is "-" too, NOT ":" -- earlier this used ":"
// on the assumption Chrome's downloads API would sanitize it per-OS, but
// on macOS Chrome rejects ":" outright with "Invalid filename" (":" is the
// classic Mac OS path separator and is disallowed in download paths), which
// broke every download. "-" is safe everywhere and stays readable.
function downloadDateFolder(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + d.getFullYear() +
    '_' + pad(d.getHours()) + '-' + pad(d.getMinutes())
  );
}

// Origin + pathname only -- ignores query strings so a cache-busting token
// (Hudl's URLs carry one, e.g. "?v=04A3BC1EBF0ADF08") that happens to differ
// between when webRequest first saw a stream and when hudlWalkStep reads
// the video element's currentSrc for it doesn't break the match.
function normalizeStreamUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return url;
  }
}

// A tiny counting semaphore -- lets Download All's orchestration queue up
// downloads as clips are matched (one at a time, as the walk progresses)
// while still capping how many run at once (2 at a time: fully sequential
// would be slow with many streams, fully unbounded parallel competes for
// the user's bandwidth and can look like a burst of abusive traffic to the
// site's server).
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  const acquire = () =>
    new Promise((resolve) => {
      const tryAcquire = () => {
        if (active < limit) {
          active++;
          resolve(release);
        } else {
          queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  return { acquire };
}

function playLabelFromFields(fields) {
  return fields && fields['PLAY #'] ? 'Play-' + fields['PLAY #'] : null;
}

// Builds a name + a per-clip metadata snapshot for one stream, in priority
// order:
//  1. streamSnapshot -- an exact per-clip source: either the clip walk's
//     own read of the toolbar at the moment it confirmed that clip's video
//     URL (source: 'walk-url-match'), or content.js's real-time read of the
//     toolbar at the exact moment this stream's own network request fired
//     (source: 'realtime-snapshot', see background.js's play history).
//  2. meta.gridRows[rowIndex] -- the play-by-play grid's row at this
//     stream's position in the detected-stream list. Only a fallback: it
//     assumes stream order matches row order, which an exact per-clip
//     source doesn't need to assume.
//  3. meta.fields / meta.playLabel -- the single "currently loaded"
//     toolbar snapshot, same as a plain Download uses.
function nameAndMetaFor(meta, rowIndex, streamSnapshot) {
  let fields = meta.fields;
  let playLabel = meta.playLabel;
  // Whether `fields` came from a real per-clip source vs. the shared
  // fallback (meta.fields = whatever clip happened to be loaded when
  // Download All was clicked). Without this flag, every clip without its
  // own data would inherit the currently-loaded clip's PLAY # as its own --
  // so every clip would get the identical name. When perClip is false we
  // drop playLabel so the caller appends an index suffix instead.
  let perClip = false;
  // Which of the three sources above actually produced this clip's data --
  // written into the sidecar as correlationSource so a wrong name can be
  // diagnosed straight from the downloaded .meta.json instead of guessing:
  // 'walk-url-match' (exact, from the clip walk), 'realtime-snapshot' (from
  // content.js's live toolbar watcher), 'grid-position', or 'none'.
  let source = 'none';

  if (streamSnapshot && streamSnapshot.fields && Object.keys(streamSnapshot.fields).length) {
    fields = streamSnapshot.fields;
    playLabel = playLabelFromFields(fields);
    perClip = true;
    source = streamSnapshot.source || 'realtime-snapshot';
  } else if (rowIndex != null && meta.gridRows && meta.gridRows[rowIndex]) {
    fields = meta.gridRows[rowIndex];
    playLabel = playLabelFromFields(fields);
    perClip = true;
    source = 'grid-position';
  }

  const parts = [];
  if (playLabel && perClip) parts.push(playLabel);
  else if (meta.pageTitle) parts.push(slugify(meta.pageTitle));
  if (meta.videoId) parts.push('v' + meta.videoId);

  // gridRows (the full play-by-play table) is carried into the sidecar so
  // the Film Room viewer can render the whole table, not just this clip's row.
  const perClipMeta = {
    videoId: meta.videoId,
    playLabel: perClip ? playLabel : null,
    pageTitle: meta.pageTitle,
    fields,
    gridRows: meta.gridRows || [],
    tables: meta.tables,
    correlationSource: source,
  };
  return { name: parts.length ? parts.join('-') : 'clip', meta: perClipMeta };
}

// Runs inside the Hudl page itself (via chrome.scripting.executeScript) to
// pull identifying info for the filename. Must be fully self-contained --
// no references to variables outside this function -- since MV3 serializes
// it and re-parses it in the target page's context.
async function extractHudlMetadata(options) {
  const result = {
    videoId: null,
    playLabel: null,
    pageTitle: document.title || null,
    tables: [],
    fields: {},
    gridRows: [],
  };

  try {
    result.videoId = new URL(location.href).searchParams.get('v');
  } catch (e) {}

  // 1) Hudl's own per-clip data fields: data-qa-id="clip-preview-<NAME>-field"
  //    on the toolbar above the video (PLAY #, DN, DIST, OFF FORM, RESULT,
  //    QTR, ...). This is Hudl's own stable test-hook attribute for exactly
  //    this data, not a guess -- confirmed against a real rendered page --
  //    so it takes priority over every generic heuristic below. Structure:
  //    each field element has a label child then a value child; reading by
  //    position (not by class name) survives Hudl's hashed CSS-module
  //    classes changing between builds.
  const hudlFieldEls = document.querySelectorAll('[data-qa-id^="clip-preview-"][data-qa-id$="-field"]');
  for (const el of hudlFieldEls) {
    const qa = el.getAttribute('data-qa-id') || '';
    const name = qa.replace(/^clip-preview-/, '').replace(/-field$/, '');
    const kids = el.children;
    if (!name || kids.length < 2) continue;
    const value = (kids[1].textContent || '').trim();
    // Hudl renders an unset field as a literal "-".
    if (value && value !== '-') result.fields[name] = value.slice(0, 200);
  }
  if (result.fields['PLAY #']) result.playLabel = 'Play-' + result.fields['PLAY #'];

  // 1b) The play-by-play grid (ag-Grid, in the Video module's sidebar) has
  //     one row per play in the game, with the same fields as columns --
  //     PLAY #, DN, DIST, OFF FORM, RESULT, etc. The toolbar above only
  //     ever describes the ONE clip currently loaded in the player, so for
  //     a batch of several clips ("Download All") it's the same data
  //     repeated for every clip -- wrong for all but one of them. This
  //     reads every row, in the grid's own row-index order, so a given
  //     clip can be paired with its own play data by matching its position
  //     among the detected streams to the same position among these rows
  //     (see nameAndMetaFor in this file). ag-Grid virtualizes rows, so by
  //     default only currently-rendered ones are captured -- fine for a
  //     game-length list that fits without scrolling, incomplete for a
  //     much longer one. When options.fullGrid is set (Download All), we
  //     programmatically scroll the grid's viewport to the bottom in steps,
  //     collecting rows as they render, then restore scroll -- defeating
  //     virtualization. The caller pauses stream detection around this so
  //     scroll-induced clip loads don't pollute the detected-streams list.
  const grid = document.querySelector('[data-qa-id="ag-grid"]');
  if (grid) {
    const headerByColId = {};
    grid.querySelectorAll('[role="columnheader"][col-id]').forEach((h) => {
      const colId = h.getAttribute('col-id');
      const text = (h.textContent || '').trim();
      if (colId && text) headerByColId[colId] = text;
    });

    const rowsByIndex = new Map();
    const collectVisible = () => {
      grid.querySelectorAll('[role="row"][row-index]').forEach((rowEl) => {
        const idx = parseInt(rowEl.getAttribute('row-index'), 10);
        if (Number.isNaN(idx) || rowsByIndex.has(idx)) return;
        const cells = rowEl.querySelectorAll('[role="gridcell"][col-id]');
        if (!cells.length) return;
        const fields = {};
        cells.forEach((cell) => {
          const name = headerByColId[cell.getAttribute('col-id')];
          const value = (cell.textContent || '').trim();
          if (name && value && value !== '-') fields[name] = value.slice(0, 200);
        });
        if (Object.keys(fields).length) rowsByIndex.set(idx, fields);
      });
    };

    if (options && options.fullGrid) {
      const vp = grid.querySelector('.ag-body-viewport') || grid.querySelector('[class*="body-viewport"]');
      if (vp) {
        const prevTop = vp.scrollTop;
        const step = Math.max(1, vp.clientHeight * 0.8);
        collectVisible();
        let guard = 0;
        while (vp.scrollTop + vp.clientHeight < vp.scrollHeight - 1 && guard++ < 1000) {
          vp.scrollTop += step;
          // ag-Grid renders asynchronously after scroll; yield a frame so the
          // newly virtualized rows are in the DOM before we collect them.
          await new Promise((r) => requestAnimationFrame(r));
          collectVisible();
        }
        vp.scrollTop = prevTop; // restore the user's scroll position
      } else {
        collectVisible(); // no scroll container found -- best effort
      }
    } else {
      collectVisible();
    }

    const maxIdx = rowsByIndex.size ? Math.max(...rowsByIndex.keys()) : -1;
    for (let i = 0; i <= maxIdx; i++) result.gridRows.push(rowsByIndex.get(i) || null);
  }

  // The rest only runs if the page didn't look like Hudl's clip-preview bar
  // -- generic, blind fallbacks for other sites.
  if (Object.keys(result.fields).length === 0) {
    // Any <table> on the page (e.g. a play-by-play grid, stat breakdown).
    const tableEls = document.querySelectorAll('table');
    for (let i = 0; i < tableEls.length && result.tables.length < 5; i++) {
      const rows = Array.from(tableEls[i].querySelectorAll('tr'))
        .slice(0, 30)
        .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').trim().slice(0, 200)))
        .filter((row) => row.some((cell) => cell));
      if (rows.length) result.tables.push(rows);
    }

    // <dl> label/value pairs (down & distance, formation, result, etc.
    // would commonly be marked up this way if they're not in a table).
    for (const dl of document.querySelectorAll('dl')) {
      for (const dt of dl.querySelectorAll('dt')) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD' && Object.keys(result.fields).length < 40) {
          const key = (dt.textContent || '').trim().slice(0, 60);
          const val = (dd.textContent || '').trim().slice(0, 200);
          if (key && val) result.fields[key] = val;
        }
      }
    }
  }

  if (!result.playLabel) {
    // \bplay\b keeps this from matching inside "playlist"/"playback"; the
    // negative lookahead after the digits rejects things like "5s" or
    // "1080p" -- unrelated player-chrome text (a Play button sitting next
    // to a "5s" skip button, say) that would otherwise produce a
    // confidently wrong play number, which is worse than no match at all.
    const playRe = /\bplay\b\s*#?\s*(\d+)(?![a-zA-Z\d])/i;

    // 2) A "Play N" label on whatever looks like the currently-selected
    //    item in a list (the common pattern for a play list UI).
    const candidates = document.querySelectorAll(
      '[class*="active" i], [class*="selected" i], [class*="current" i], [aria-current="true"], [aria-selected="true"]'
    );
    for (const el of candidates) {
      const m = (el.textContent || '').trim().match(playRe);
      if (m) {
        result.playLabel = 'Play-' + m[1];
        break;
      }
    }
  }

  // 3) Fall back to scanning all visible text on the page.
  if (!result.playLabel) {
    const m = (document.body.innerText || '').match(/\bplay\b\s*#?\s*(\d+)(?![a-zA-Z\d])/i);
    if (m) result.playLabel = 'Play-' + m[1];
  }

  // 4) Fall back further to structured data some SPAs embed in an inline
  //    <script> (Redux/Angular initial-state style blobs) even when it
  //    isn't rendered as visible text.
  if (!result.playLabel) {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const m = (script.textContent || '').match(/"play(?:Number|Index)"\s*:\s*"?(\d+)"?/i);
      if (m) {
        result.playLabel = 'Play-' + m[1];
        break;
      }
    }
  }

  return result;
}

// The three functions below (rewindHudlClips, hudlWalkStep,
// restoreHudlPosition) all run in the page itself (MAIN world), only for
// "Download All", to click through Hudl's reel/playlist navigator (the
// "N / M" clip counter + Next/Previous buttons above the video -- distinct
// from the play-by-play grid) and read each clip's own toolbar fields plus
// the video element's actual resolved URL as we go.
//
// Why this exists: Download All is meant to save the user from visiting
// every clip individually, but Hudl frequently pre-fetches every clip's
// video before the user has looked at any of them (that's why several
// streams can already be detected the moment the popup opens). When that
// happens there's nothing for a passive real-time watcher (content.js) to
// correlate against -- only ONE "currently active play" report ever exists,
// whatever was on screen when the button was clicked -- so every stream
// ends up tagged with that same snapshot (see the per-stream trust check in
// background.js's runDownloadAll, which is exactly what that's guarding
// against). Positional grid-row matching is the fallback for that case, but
// it's still a guess: it assumes stream-detection order matches the grid's
// row order. Driving the navigation ourselves removes the guesswork
// entirely -- we know exactly which clip index we're on at each step, and
// reading the video element's own currentSrc gives an EXACT URL to match
// back against the detected streams.
//
// These are three separate functions, one per step, rather than one big
// loop that walks every clip before returning -- so the caller can start a
// matched clip's download the moment that ONE step finishes, instead of
// waiting for all N clips to be walked first. Walking is the slow part (see
// hudlWalkStep's comment on why), so overlapping it with downloading
// instead of doing the two in sequence is the difference between total
// time being walk-time-plus-download-time and roughly whichever is larger.

// Step 0: rewind to clip 1 so the walk that follows always starts from a
// known position, regardless of whichever clip the user happened to have
// open, and hand back where they actually were so it can be restored later.
async function rewindHudlClips() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const countEl = () => document.querySelector('[data-qa-id="clip-context-clip-count"]');
  const parseCount = (text) => {
    const m = (text || '').match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { current: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
  };
  const prevBtn = () => document.querySelector('button[aria-label="Previous"]');

  const initial = parseCount(countEl() && countEl().textContent);
  // No clip counter -- this isn't a reel/playlist page (e.g. a plain game
  // film grid with no clip-to-clip navigator). Nothing to walk; the caller
  // falls back to its other correlation strategies for every stream.
  if (!initial) return { total: 0, initialIndex: null };

  // The counter itself is plain React state and updates in well under
  // 250ms, so wait for it to actually decrement after each click (up to a
  // short per-click cap) rather than a flat delay -- faster when it's
  // quicker than that, and safer than assuming it always is.
  for (let guard = 0; guard < initial.total + 2; guard++) {
    const before = parseCount(countEl() && countEl().textContent);
    if (!before || before.current <= 1) break;
    const btn = prevBtn();
    if (!btn || btn.disabled) break;
    btn.click();
    const clickStart = Date.now();
    while (Date.now() - clickStart < 1500) {
      const c = parseCount(countEl() && countEl().textContent);
      if (c && c.current < before.current) break;
      await wait(50);
    }
  }

  return { total: initial.total, initialIndex: initial.current };
}

// One walk step: read the clip currently on screen, then (unless told this
// is the last one) advance to the next. `previousVideoUrl` is whatever the
// last step returned (or null for the first).
//
// Confirmed by direct testing against the live page: the clip counter and
// toolbar fields update on a Next click almost immediately (plain React
// state), but the <video> element's own src takes noticeably longer to
// actually swap over -- reading it right after the click, or after only a
// short flat wait, reads the PREVIOUS clip's still-loaded video every
// single time (this is exactly what made the first version of this walker
// useless: it visibly cycled through every play's data correctly, but every
// downloaded file still got named after the first clip). Its URL also
// carries what looks like a per-clip signed token, suggesting Hudl fetches
// a fresh signed URL from its own backend on each clip switch -- a real
// network round trip, not something a client-side wait can shortcut. A
// direct, precisely-timed measurement against the live page showed this
// typically lands around 1-1.5s, so this polls (every 150ms, up to a 3s
// cap -- still ~2x the typical case) for the URL to become something other
// than `previousVideoUrl`, and reports how long this step actually waited
// so slow outliers show up in the walk's console diagnostics instead of
// just being an unexplained slow run. A step that hits the cap without the
// URL changing isn't wrong, just unmatched: it returns whatever's there
// (the previous clip's still-loaded URL), which the caller's URL-matching
// will already have claimed for that earlier clip, so this stream falls
// through to the same real-time/positional fallback chain as any other
// unmatched stream -- degraded (a guess instead of an exact match), never
// silently wrong.
async function hudlWalkStep(previousVideoUrl, hasNext) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const activeVideoUrl = () => {
    for (const v of document.querySelectorAll('video')) {
      if (getComputedStyle(v).display === 'none') continue;
      const src = v.currentSrc || v.getAttribute('src') || '';
      // blob: URLs (an adaptive-streaming player feeding MediaSource
      // Extensions) can't be matched against the plain http(s) URLs
      // webRequest detects -- the caller falls back to other signals then.
      if (src && !src.startsWith('blob:')) return src;
    }
    return null;
  };

  const start = Date.now();
  let videoUrl = activeVideoUrl();
  while (Date.now() - start < 3000 && (!videoUrl || videoUrl === previousVideoUrl)) {
    await wait(150);
    videoUrl = activeVideoUrl();
  }
  const waitedMs = Date.now() - start;

  const fields = {};
  document.querySelectorAll('[data-qa-id^="clip-preview-"][data-qa-id$="-field"]').forEach((el) => {
    const qa = el.getAttribute('data-qa-id') || '';
    const name = qa.replace(/^clip-preview-/, '').replace(/-field$/, '');
    const kids = el.children;
    if (!name || kids.length < 2) return;
    const value = (kids[1].textContent || '').trim();
    if (value && value !== '-') fields[name] = value.slice(0, 200);
  });

  if (hasNext) {
    const btn = document.querySelector('button[aria-label="Next"]');
    if (btn && !btn.disabled) btn.click();
  }

  return { fields, playLabel: fields['PLAY #'] ? 'Play-' + fields['PLAY #'] : null, videoUrl, waitedMs };
}

// Fire-and-forget, after the walk finishes: clicks forward to whichever
// clip the user actually had open before Download All started. Never
// awaited by the caller -- it only affects what's on screen, not any
// downloaded data, so it must never delay a download that's already
// underway or hasn't started yet.
async function restoreHudlPosition(targetIndex) {
  if (targetIndex == null) return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const countEl = () => document.querySelector('[data-qa-id="clip-context-clip-count"]');
  const parseCount = (text) => {
    const m = (text || '').match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { current: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
  };
  const nextBtn = () => document.querySelector('button[aria-label="Next"]');
  for (let guard = 0; guard < 60; guard++) {
    const c = parseCount(countEl() && countEl().textContent);
    if (!c || c.current >= targetIndex) break;
    const btn = nextBtn();
    if (!btn || btn.disabled) break;
    btn.click();
    await wait(200);
  }
}

// Runs in the page itself (MAIN world), called repeatedly during Download
// All to create/update a floating on-page progress indicator. This exists
// alongside the popup's own progress bar because an extension popup closes
// the instant the user clicks anywhere outside it -- easy to do without
// thinking during a walk that can take 30-60+ seconds -- so a purely
// in-popup indicator can vanish the moment someone glances back at the page
// it's about. Since the actual walk + downloads run from the background
// service worker (see background.js's runDownloadAll), not the popup, this
// overlay (and the work it's reporting on) keeps updating even if the
// popup never reopens. Self-contained and idempotent: safe to call many
// times with fresh state; creates the element on first call, just updates
// it after that.
function updateFilmRoomOverlay(state) {
  const ID = 'film-room-downloader-overlay';
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    el.style.cssText = [
      'position:fixed',
      // Bottom-right, not top-right: Chrome's own native downloads
      // dropdown auto-opens in the top-right (anchored to the browser's
      // downloads toolbar button) the moment several downloads land in a
      // burst -- exactly what Download All triggers -- and it visually
      // clashes with anything else placed in that same corner (including
      // the extension's own popup, which Chrome anchors there too and
      // this extension has no control over). Bottom-right is out of reach
      // of both.
      'bottom:20px',
      'right:20px',
      'z-index:2147483647',
      'background:#14161a',
      'color:#e8eaed',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:16px',
      'padding:18px 20px',
      'border-radius:10px',
      'border:1px solid #333844',
      'box-shadow:0 8px 28px rgba(0,0,0,0.5)',
      'width:340px',
      'pointer-events:none',
    ].join(';');
    el.innerHTML =
      '<div style="margin-bottom:10px;font-weight:700;line-height:1.35;" data-role="label"></div>' +
      '<div style="height:12px;background:#262a33;border-radius:6px;overflow:hidden;">' +
      '<div style="height:100%;background:#ff6a1a;width:0%;transition:width 0.2s;" data-role="fill"></div>' +
      '</div>';
    document.body.appendChild(el);
  }
  const label = el.querySelector('[data-role="label"]');
  const fill = el.querySelector('[data-role="fill"]');
  if (label) label.textContent = state.label || '';
  if (fill) fill.style.width = Math.max(0, Math.min(100, state.percent || 0)) + '%';
  if (state.done) {
    setTimeout(() => {
      const e = document.getElementById(ID);
      if (e) e.remove();
    }, 4000);
  }
}
