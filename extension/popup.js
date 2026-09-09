// Runs inside the Hudl page itself (via chrome.scripting.executeScript) to
// pull identifying info for the filename. Must be fully self-contained --
// no references to variables outside this function -- since MV3 serializes
// it and re-parses it in the target page's context.
function extractHudlMetadata() {
  const result = { videoId: null, playLabel: null, pageTitle: document.title || null };

  try {
    result.videoId = new URL(location.href).searchParams.get('v');
  } catch (e) {}

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

(async function () {
  const listEl = document.getElementById('list');
  const progressEl = document.getElementById('progress');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const { streams } = await chrome.runtime.sendMessage({ type: 'get-streams', tabId: tab.id });

  if (!streams || !streams.length) {
    listEl.innerHTML = '<div class="hint">No manifest detected yet. Play the video on this page, then reopen this popup.</div>';
    return;
  }

  let jobCounter = 0;

  const typeLabels = { hls: 'HLS stream', dash: 'DASH stream', progressive: 'Direct video file' };

  streams.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'stream';
    const label = typeLabels[s.type] || (s.type.toUpperCase() + ' stream');
    row.innerHTML = `
      <div>${label}</div>
      <div class="url">${s.url}</div>
      <button data-url="${s.url}" data-type="${s.type}">Download</button>
      <div class="hint" style="margin-top:4px;"></div>
    `;
    const nameHint = row.querySelector('.hint');
    row.querySelector('button').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const { name, meta } = await buildClipName(tab.id);
      nameHint.textContent = 'Naming as: ' + name + (meta.playLabel ? '' : ' (no play number found on page — using page title + video id)');
      const jobId = 'job-' + Date.now() + '-' + jobCounter++;
      chrome.runtime.sendMessage({
        type: 'start-job',
        jobId,
        manifestUrl: btn.dataset.url,
        streamType: btn.dataset.type,
        title: name,
      });
      trackJob(jobId);
    });
    listEl.appendChild(row);
  });

  function trackJob(jobId) {
    progressEl.innerHTML = `
      <div id="status-${jobId}">Starting…</div>
      <div class="bar"><div class="bar-fill" id="fill-${jobId}"></div></div>
    `;
    chrome.runtime.onMessage.addListener(function listener(msg) {
      if (msg.type !== 'job-progress' || msg.jobId !== jobId) return;
      const statusEl = document.getElementById(`status-${jobId}`);
      const fillEl = document.getElementById(`fill-${jobId}`);
      if (!statusEl) return;
      if (msg.status === 'fetching-manifest') {
        statusEl.textContent = 'Reading playlist…';
      } else if (msg.status === 'downloading') {
        statusEl.textContent = `Downloading segment ${msg.done}/${msg.total}`;
        if (fillEl) fillEl.style.width = Math.round((msg.done / msg.total) * 100) + '%';
      } else if (msg.status === 'done') {
        statusEl.textContent = msg.noRemuxNeeded
          ? `Done. Saved to Downloads/${msg.folder} — already a playable file, no remux needed.`
          : `Done. Saved to Downloads/${msg.folder}. Run: node downloader/remux.js "<path-to-folder>"`;
        chrome.runtime.onMessage.removeListener(listener);
      } else if (msg.status === 'error') {
        statusEl.textContent = 'Error: ' + msg.message;
        statusEl.classList.add('error');
        chrome.runtime.onMessage.removeListener(listener);
      }
    });
  }
})();
