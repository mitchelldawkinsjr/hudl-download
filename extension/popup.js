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
  };

  try {
    result.videoId = new URL(location.href).searchParams.get('v');
  } catch (e) {}

  // Any <table> on the page (e.g. a play-by-play grid, stat breakdown) --
  // capped and truncated since this is a blind whole-document scan with no
  // idea what Hudl's actual layout looks like.
  const tableEls = document.querySelectorAll('table');
  for (let i = 0; i < tableEls.length && result.tables.length < 5; i++) {
    const rows = Array.from(tableEls[i].querySelectorAll('tr'))
      .slice(0, 30)
      .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').trim().slice(0, 200)))
      .filter((row) => row.some((cell) => cell));
    if (rows.length) result.tables.push(rows);
  }

  // <dl> label/value pairs (down & distance, formation, result, etc. would
  // commonly be marked up this way if they're not in a table).
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

  // \bplay\b keeps this from matching inside "playlist"/"playback"; the
  // negative lookahead after the digits rejects things like "5s" or "1080p"
  // -- unrelated player-chrome text (a Play button sitting next to a "5s"
  // skip button, say) that would otherwise produce a confidently wrong
  // play number, which is worse than no match at all.
  const playRe = /\bplay\b\s*#?\s*(\d+)(?![a-zA-Z\d])/i;

  // 1) A "Play N" label on whatever looks like the currently-selected item
  //    in a list (the common pattern for a play list UI).
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

  // 2) Fall back to scanning all visible text on the page.
  if (!result.playLabel) {
    const m = (document.body.innerText || '').match(playRe);
    if (m) result.playLabel = 'Play-' + m[1];
  }

  // 3) Fall back further to structured data some SPAs embed in an inline
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

async function buildClipName(tabId) {
  let meta = { videoId: null, playLabel: null, pageTitle: null };
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

  const parts = [];
  if (meta.playLabel) parts.push(meta.playLabel);
  else if (meta.pageTitle) parts.push(slugify(meta.pageTitle));
  if (meta.videoId) parts.push('v' + meta.videoId);

  return { name: parts.length ? parts.join('-') : 'clip', meta };
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

  function startJob(stream, name, label, playInfo) {
    const jobId = 'job-' + Date.now() + '-' + jobCounter++;
    chrome.runtime.sendMessage({
      type: 'start-job',
      jobId,
      manifestUrl: stream.url,
      streamType: stream.type,
      title: name,
      playInfo,
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
      const { name, meta } = await buildClipName(tab.id);
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

      const { name: baseName, meta } = await buildClipName(tab.id);
      const summary = document.createElement('div');
      summary.className = 'hint';
      progressEl.appendChild(summary);

      let done = 0;
      const update = () => (summary.textContent = `Downloading ${done}/${streams.length} streams…`);
      update();

      await runWithConcurrency(streams, 2, async (s, i) => {
        const label = typeLabels[s.type] || s.type;
        // Every stream gets its own numbered name so they never collide,
        // even if the page-level metadata (e.g. a play number) is
        // identical across all of them.
        await startJob(s, `${baseName}-${i + 1}`, label, meta);
        done++;
        update();
      });

      summary.textContent = `All ${streams.length} streams downloaded.`;
    });
  }
})();
