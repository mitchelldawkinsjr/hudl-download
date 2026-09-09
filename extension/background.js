importScripts('m3u8.js');

// tabId -> [{ url, type, time }]
const streamsByTab = {};

function isManifestUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !isManifestUrl(details.url)) return;
    const list = streamsByTab[details.tabId] || (streamsByTab[details.tabId] = []);
    if (!list.some((s) => s.url === details.url)) {
      list.push({
        url: details.url,
        type: details.url.includes('.mpd') ? 'dash' : 'hls',
        time: Date.now(),
      });
      chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) });
      chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: '#ff6a1a' });
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete streamsByTab[tabId];
});

function slugify(s) {
  return (s || 'clip').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId == null) {
        reject(new Error(chrome.runtime.lastError && chrome.runtime.lastError.message));
        return;
      }
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          resolve(downloadId);
        } else if (delta.state && delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error('Download interrupted: ' + filename));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

function toDataUrl(text) {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return 'data:text/plain;base64,' + b64;
}

async function runJob(jobId, manifestUrl, title) {
  const folder = 'FilmRoomDownloads/' + slugify(title);
  const post = (patch) => chrome.runtime.sendMessage({ type: 'job-progress', jobId, ...patch }).catch(() => {});

  try {
    post({ status: 'fetching-manifest' });
    let text = await fetch(manifestUrl, { credentials: 'include' }).then((r) => r.text());
    let mediaUrl = manifestUrl;

    if (HlsParser.isMasterPlaylist(text)) {
      const variants = HlsParser.parseMaster(text, manifestUrl);
      if (!variants.length) throw new Error('Master playlist had no variants');
      // Pick the highest-bandwidth variant by default.
      variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      mediaUrl = variants[0].url;
      text = await fetch(mediaUrl, { credentials: 'include' }).then((r) => r.text());
    }

    const { initUrl, segments } = HlsParser.parseMedia(text, mediaUrl);
    if (!segments.length) throw new Error('No segments found in media playlist');

    const total = segments.length + (initUrl ? 1 : 0);
    post({ status: 'downloading', done: 0, total });

    const localNames = [];
    let done = 0;

    if (initUrl) {
      const ext = (initUrl.split('?')[0].match(/\.(\w+)$/) || [, 'mp4'])[1];
      const name = `init.${ext}`;
      await downloadFile(initUrl, `${folder}/${name}`);
      localNames.push(name);
      done += 1;
      post({ status: 'downloading', done, total });
    }

    for (let i = 0; i < segments.length; i++) {
      const segUrl = segments[i];
      const ext = (segUrl.split('?')[0].match(/\.(\w+)$/) || [, 'ts'])[1];
      const name = `seg-${String(i).padStart(5, '0')}.${ext}`;
      await downloadFile(segUrl, `${folder}/${name}`);
      localNames.push(name);
      done += 1;
      post({ status: 'downloading', done, total });
    }

    const concatList = localNames
      .filter((n) => !n.startsWith('init.'))
      .map((n) => `file '${n}'`)
      .join('\n') + '\n';
    await downloadFile(toDataUrl(concatList), `${folder}/concat_list.txt`);

    post({ status: 'done', folder });
  } catch (err) {
    post({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-streams') {
    sendResponse({ streams: streamsByTab[msg.tabId] || [] });
    return true;
  }
  if (msg.type === 'clear-streams') {
    delete streamsByTab[msg.tabId];
    chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'start-job') {
    runJob(msg.jobId, msg.manifestUrl, msg.title);
    sendResponse({ ok: true });
    return true;
  }
});
