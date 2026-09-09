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
    `;
    row.querySelector('button').addEventListener('click', (e) => {
      const btn = e.target;
      btn.disabled = true;
      const jobId = 'job-' + Date.now() + '-' + jobCounter++;
      chrome.runtime.sendMessage({
        type: 'start-job',
        jobId,
        manifestUrl: btn.dataset.url,
        streamType: btn.dataset.type,
        title: tab.title || 'clip',
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
