// extractHudlMetadata, nameAndMetaFor, playLabelFromFields, slugify,
// downloadDateFolder, normalizeStreamUrl, and the clip-walk functions
// (rewindHudlClips, hudlWalkStep, restoreHudlPosition, updateFilmRoomOverlay)
// all live in download-all.js (loaded via a <script> tag before this file
// in popup.html), shared with background.js so both use the exact same
// logic -- see that file's own comments for the reasoning behind each one.
// Download All's actual walk-and-download orchestration now runs entirely
// in background.js's runDownloadAll, not here: an extension popup closes
// the instant the user clicks anywhere outside it, which would otherwise
// kill a run that can take 30-60+ seconds partway through. This file just
// triggers that run and reflects its progress while open.

async function fetchPageMeta(tabId, fullGrid) {
  let meta = { videoId: null, playLabel: null, pageTitle: null, fields: {}, tables: [], gridRows: [] };
  try {
    // Pause stream detection while we scroll the grid so scroll-induced
    // clip loads don't add spurious entries to the detected-streams list.
    if (fullGrid) {
      try { await chrome.runtime.sendMessage({ type: 'pause-detection', tabId }); } catch (e) {}
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractHudlMetadata,
      args: [{ fullGrid: !!fullGrid }],
    });
    if (result) meta = result;
  } catch (e) {
    // scripting can be refused on some pages -- fall back to whatever we have
  } finally {
    if (fullGrid) {
      try { await chrome.runtime.sendMessage({ type: 'resume-detection', tabId }); } catch (e) {}
    }
  }
  return meta;
}

async function buildClipName(tabId, streamSnapshot) {
  const meta = await fetchPageMeta(tabId);
  return nameAndMetaFor(meta, null, streamSnapshot);
}

(async function () {
  const listEl = document.getElementById('list');
  const progressEl = document.getElementById('progress');
  const downloadAllBtn = document.getElementById('downloadAll');
  const overallProgressEl = document.getElementById('overallProgress');
  const overallStatusEl = document.getElementById('overallStatus');
  const overallBarFillEl = document.getElementById('overallBarFill');

  // Opens the Film Room offline player (web/index.html, symlinked into this
  // extension's own folder so it's a normal same-origin extension resource)
  // in a new tab -- works regardless of whether any streams have been
  // detected yet, so it's wired before that check below.
  document.getElementById('openFilmRoom').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('web/index.html') });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const showDownloadAllProgress = (state) => {
    if (!state) return;
    overallProgressEl.style.display = 'block';
    overallStatusEl.textContent = state.label || '';
    overallBarFillEl.style.width = (state.percent || 0) + '%';
    if (state.running || state.finished) {
      // Reopening the popup mid-run (or right after one finishes) can land
      // here before the streams.length>1 check below has had a chance to
      // reveal the button -- force it visible so "disabled" doesn't also
      // mean invisible.
      downloadAllBtn.style.display = 'block';
      downloadAllBtn.disabled = true;
      document.querySelectorAll('.download-one').forEach((b) => (b.disabled = true));
    }
  };

  // Reflect a Download All run that's still going (or just finished) from
  // before this popup was (re)opened -- the run itself lives in
  // background.js and doesn't wait for a popup to be watching.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'download-all-progress' || msg.tabId !== tab.id) return;
    showDownloadAllProgress(msg);
  });
  let restoredDownloadAllState = null;
  try {
    const { state } = await chrome.runtime.sendMessage({ type: 'get-download-all-status', tabId: tab.id });
    restoredDownloadAllState = state;
    showDownloadAllProgress(state);
  } catch (e) {}

  let jobCounter = 0;
  const typeLabels = { hls: 'HLS stream', dash: 'DASH stream', progressive: 'Direct video file' };
  const noStreamsHint = '<div class="hint">No manifest detected yet. Play the video on this page, then reopen this popup.</div>';

  // A job's own progress gets its own block appended to #progress, rather
  // than replacing its contents -- otherwise a second job would wipe out an
  // earlier job's still-in-progress status. Only used for the single
  // per-stream Download button below -- Download All shows its combined
  // progress in #overallProgress instead (see showDownloadAllProgress).
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

  function startJob(stream, name, label, playInfo, folder, dateFolder) {
    const jobId = 'job-' + Date.now() + '-' + jobCounter++;
    chrome.runtime.sendMessage({
      type: 'start-job',
      jobId,
      manifestUrl: stream.url,
      streamType: stream.type,
      title: name,
      playInfo,
      folder,
      dateFolder,
    });
    return trackJob(jobId, label);
  }

  function addStreamRow(s) {
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
    const btn = row.querySelector('button');
    btn.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const dateFolder = downloadDateFolder(new Date()); // captured at click time, not after the async metadata fetch below
      const { name, meta } = await buildClipName(tab.id, s.playSnapshot);
      nameHint.textContent = 'Naming as: ' + name + (meta.playLabel ? '' : ' (no play number found on page — using page title + video id)');
      startJob(s, name, label, meta, undefined, dateFolder);
    });
    // If a Download All is already running (or just finished), this row's
    // own button should start disabled too, same as the ones already on
    // screen -- see applyStreams below, which is also what calls this for
    // every row already rendered whenever the list grows.
    if (restoredDownloadAllState && (restoredDownloadAllState.running || restoredDownloadAllState.finished)) {
      btn.disabled = true;
    }
    listEl.appendChild(row);
  }

  downloadAllBtn.addEventListener('click', async () => {
    downloadAllBtn.disabled = true;
    document.querySelectorAll('.download-one').forEach((b) => (b.disabled = true));
    overallProgressEl.style.display = 'block';
    overallStatusEl.textContent = 'Starting…';
    overallBarFillEl.style.width = '0%';
    // The actual walk + downloads run in background.js's runDownloadAll,
    // not here -- see the comment at the top of this file. This just
    // triggers it; showDownloadAllProgress (wired above) picks up its
    // progress broadcasts, and will keep doing so even if this popup
    // closes and gets reopened mid-run. runDownloadAll re-reads the
    // detected-streams list itself when it starts, so it downloads
    // whatever's actually been detected by then -- not just whatever this
    // button's count says (see applyStreams' comment on why that count can
    // lag behind).
    await chrome.runtime.sendMessage({ type: 'start-download-all', tabId: tab.id });
  });

  // Renders any streams not already shown, and updates the Download All
  // button's count -- called once for whatever's already been detected
  // when the popup opens, and again every time a 'streams-updated'
  // broadcast arrives (see the listener below). Hudl keeps prefetching
  // clips after the page first loads, so the count here can legitimately
  // grow for several seconds after the popup opens -- that's not stale
  // data being wrong, it's genuinely more streams landing; this keeps the
  // popup honest about "what's been detected so far" without needing to be
  // reopened to see the rest show up.
  let renderedCount = 0;
  function applyStreams(streams) {
    if (!streams || !streams.length) {
      if (renderedCount === 0) listEl.innerHTML = noStreamsHint;
      return;
    }
    if (renderedCount === 0) listEl.innerHTML = ''; // clear the "no manifest detected yet" hint
    for (let i = renderedCount; i < streams.length; i++) addStreamRow(streams[i]);
    renderedCount = streams.length;

    if (streams.length > 1) {
      downloadAllBtn.style.display = 'block';
      if (!restoredDownloadAllState || (!restoredDownloadAllState.running && !restoredDownloadAllState.finished)) {
        downloadAllBtn.textContent = `Download All (${streams.length})`;
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'streams-updated' || msg.tabId !== tab.id) return;
    chrome.runtime
      .sendMessage({ type: 'get-streams', tabId: tab.id })
      .then(({ streams }) => applyStreams(streams))
      .catch(() => {});
  });

  const { streams } = await chrome.runtime.sendMessage({ type: 'get-streams', tabId: tab.id });
  applyStreams(streams);
})();
