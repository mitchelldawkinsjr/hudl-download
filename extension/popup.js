// Runs inside the Hudl page itself (via chrome.scripting.executeScript) to
// pull identifying info for the filename. Must be fully self-contained --
// no references to variables outside this function -- since MV3 serializes
// it and re-parses it in the target page's context.
function extractHudlMetadata() {
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
  //     reads every visible row, in the grid's own row-index order, so a
  //     given clip can be paired with its own play data by matching its
  //     position among the detected streams to the same position among
  //     these rows (see nameAndMetaFor in this file). ag-Grid virtualizes
  //     rows, so only currently-rendered ones are captured -- fine for a
  //     game-length list that fits without scrolling, incomplete for a
  //     much longer one.
  const grid = document.querySelector('[data-qa-id="ag-grid"]');
  if (grid) {
    const headerByColId = {};
    grid.querySelectorAll('[role="columnheader"][col-id]').forEach((h) => {
      const colId = h.getAttribute('col-id');
      const text = (h.textContent || '').trim();
      if (colId && text) headerByColId[colId] = text;
    });

    const rowsByIndex = new Map();
    grid.querySelectorAll('[role="row"][row-index]').forEach((rowEl) => {
      const cells = rowEl.querySelectorAll('[role="gridcell"][col-id]');
      if (!cells.length) return;
      const idx = parseInt(rowEl.getAttribute('row-index'), 10);
      if (Number.isNaN(idx)) return;
      const fields = {};
      cells.forEach((cell) => {
        const colId = cell.getAttribute('col-id');
        const name = headerByColId[colId];
        const value = (cell.textContent || '').trim();
        if (name && value && value !== '-') fields[name] = value.slice(0, 200);
      });
      if (Object.keys(fields).length) rowsByIndex.set(idx, fields);
    });

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

function slugify(s) {
  return (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function fetchPageMeta(tabId) {
  let meta = { videoId: null, playLabel: null, pageTitle: null, fields: {}, tables: [], gridRows: [] };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractHudlMetadata,
    });
    if (result) meta = result;
  } catch (e) {
    // scripting can be refused on some pages -- fall back to whatever we have
  }
  return meta;
}

function playLabelFromFields(fields) {
  return fields && fields['PLAY #'] ? 'Play-' + fields['PLAY #'] : null;
}

// Builds a name + a per-clip metadata snapshot for one stream, in priority
// order:
//  1. streamSnapshot -- content.js's real-time read of the toolbar at the
//     exact moment this stream's own network request fired (see
//     background.js's currentPlayByTab). This is the accurate source: it's
//     reading the same field the toolbar itself is driven by, tied to the
//     one event that actually matters for this specific stream.
//  2. meta.gridRows[rowIndex] -- the play-by-play grid's row at this
//     stream's position in the detected-stream list. Only a fallback: it
//     assumes stream order matches row order, which a real-time snapshot
//     doesn't need to assume (used when the extension was reloaded, or
//     content.js hadn't reported yet, when this stream was detected).
//  3. meta.fields / meta.playLabel -- the single "currently loaded"
//     toolbar snapshot, same as a plain Download uses.
function nameAndMetaFor(meta, rowIndex, streamSnapshot) {
  let fields = meta.fields;
  let playLabel = meta.playLabel;

  if (streamSnapshot && streamSnapshot.fields && Object.keys(streamSnapshot.fields).length) {
    fields = streamSnapshot.fields;
    playLabel = playLabelFromFields(fields);
  } else if (rowIndex != null && meta.gridRows && meta.gridRows[rowIndex]) {
    fields = meta.gridRows[rowIndex];
    playLabel = playLabelFromFields(fields);
  }

  const parts = [];
  if (playLabel) parts.push(playLabel);
  else if (meta.pageTitle) parts.push(slugify(meta.pageTitle));
  if (meta.videoId) parts.push('v' + meta.videoId);

  const perClipMeta = { videoId: meta.videoId, playLabel, pageTitle: meta.pageTitle, fields, tables: meta.tables };
  return { name: parts.length ? parts.join('-') : 'clip', meta: perClipMeta };
}

async function buildClipName(tabId, streamSnapshot) {
  const meta = await fetchPageMeta(tabId);
  return nameAndMetaFor(meta, null, streamSnapshot);
}

// Runs up to `limit` workers over `items` concurrently, rather than either
// fully sequential (slow with many streams) or fully unbounded parallel
// (competes for the user's bandwidth and can look like a burst of abusive
// traffic to the site's server). 2 at a time is a reasonable middle ground.
async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

(async function () {
  const listEl = document.getElementById('list');
  const progressEl = document.getElementById('progress');
  const downloadAllBtn = document.getElementById('downloadAll');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const { streams } = await chrome.runtime.sendMessage({ type: 'get-streams', tabId: tab.id });

  if (!streams || !streams.length) {
    listEl.innerHTML = '<div class="hint">No manifest detected yet. Play the video on this page, then reopen this popup.</div>';
    return;
  }

  let jobCounter = 0;
  const typeLabels = { hls: 'HLS stream', dash: 'DASH stream', progressive: 'Direct video file' };

  // A job's own progress gets its own block appended to #progress, rather
  // than replacing its contents -- otherwise a second job (or "Download
  // All") would wipe out an earlier job's still-in-progress status.
  function trackJob(jobId, label) {
    const block = document.createElement('div');
    block.className = 'job-block';
    const prefix = label ? label + ' — ' : '';
    block.innerHTML = `
      <div id="status-${jobId}">${prefix}Starting…</div>
      <div class="bar"><div class="bar-fill" id="fill-${jobId}"></div></div>
    `;
    progressEl.appendChild(block);

    return new Promise((resolve) => {
      chrome.runtime.onMessage.addListener(function listener(msg) {
        if (msg.type !== 'job-progress' || msg.jobId !== jobId) return;
        const statusEl = document.getElementById(`status-${jobId}`);
        const fillEl = document.getElementById(`fill-${jobId}`);
        if (!statusEl) return;
        if (msg.status === 'fetching-manifest') {
          statusEl.textContent = prefix + 'Reading playlist…';
        } else if (msg.status === 'downloading') {
          statusEl.textContent = prefix + `Downloading ${msg.done}/${msg.total}`;
          if (fillEl) fillEl.style.width = Math.round((msg.done / msg.total) * 100) + '%';
        } else if (msg.status === 'done') {
          statusEl.textContent =
            prefix +
            (msg.noRemuxNeeded
              ? `Done. Saved to Downloads/${msg.folder} — already playable, no remux needed.`
              : `Done. Saved to Downloads/${msg.folder}. Run: node downloader/remux.js "<path-to-folder>"`);
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: true });
        } else if (msg.status === 'error') {
          statusEl.textContent = prefix + 'Error: ' + msg.message;
          statusEl.classList.add('error');
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: false, message: msg.message });
        }
      });
    });
  }

  function startJob(stream, name, label, playInfo, folder) {
    const jobId = 'job-' + Date.now() + '-' + jobCounter++;
    chrome.runtime.sendMessage({
      type: 'start-job',
      jobId,
      manifestUrl: stream.url,
      streamType: stream.type,
      title: name,
      playInfo,
      folder,
    });
    return trackJob(jobId, label);
  }

  streams.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'stream';
    const label = typeLabels[s.type] || (s.type.toUpperCase() + ' stream');
    row.innerHTML = `
      <div>${label}</div>
      <div class="url">${s.url}</div>
      <button class="download-one">Download</button>
      <div class="hint" style="margin-top:4px;"></div>
    `;
    const nameHint = row.querySelector('.hint');
    row.querySelector('button').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const { name, meta } = await buildClipName(tab.id, s.playSnapshot);
      nameHint.textContent = 'Naming as: ' + name + (meta.playLabel ? '' : ' (no play number found on page — using page title + video id)');
      startJob(s, name, label, meta);
    });
    listEl.appendChild(row);
  });

  if (streams.length > 1) {
    downloadAllBtn.style.display = 'block';
    downloadAllBtn.textContent = `Download All (${streams.length})`;
    downloadAllBtn.addEventListener('click', async () => {
      downloadAllBtn.disabled = true;
      document.querySelectorAll('.download-one').forEach((b) => (b.disabled = true));

      const meta = await fetchPageMeta(tab.id);
      // The shared download folder is still named after whichever clip is
      // currently loaded (or the page title) -- it's just a folder name,
      // not attributed to any one play.
      const { name: baseName } = nameAndMetaFor(meta, null);
      const summary = document.createElement('div');
      summary.className = 'hint';
      progressEl.appendChild(summary);

      let done = 0;
      const update = () => (summary.textContent = `Downloading ${done}/${streams.length} streams…`);
      update();

      await runWithConcurrency(streams, 2, async (s, i) => {
        const label = typeLabels[s.type] || s.type;
        // Each stream gets its own play data -- preferring the real-time
        // snapshot captured when its request fired (see nameAndMetaFor),
        // falling back to its position in the play-by-play grid, so it's
        // not a copy of whichever clip was on screen when the batch
        // started. Falls back further to an index suffix (not a wrong
        // play number) when neither source is available.
        const { name: rowName, meta: rowMeta } = nameAndMetaFor(meta, i, s.playSnapshot);
        const finalName = rowMeta.playLabel ? rowName : `${rowName}-${i + 1}`;
        await startJob(s, finalName, label, rowMeta, baseName);
        done++;
        update();
      });

      summary.textContent = `All ${streams.length} streams downloaded to Downloads/FilmRoomDownloads/${slugify(baseName)}.`;
    });
  }
})();
