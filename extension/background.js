importScripts('m3u8.js', 'download-all.js');

// tabId -> [{ url, type, time, playSnapshot }]
const streamsByTab = {};

// tabId -> [{ playNumber, fields, time }, ...] (newest last) -- a short
// history of "currently active play" reports from content.js watching the
// page's per-clip fields live. Keeping a history (not just the latest slot)
// lets us correlate each detected stream to the play that was on screen at
// the moment its request fired by TIMESTAMP, not "whatever reported last" --
// which is wrong if two play-changes report in quick succession and a stream
// request fires between them. Used to tag each stream with the play actually
// on screen at that instant, instead of assuming stream order matches the
// play-by-play grid's row order (which breaks if a play requests more than
// one camera angle, or if plays are viewed out of order).
const playHistoryByTab = {};
const MAX_PLAY_HISTORY = 200;

// How far back (ms) a fresh "current-play" report is allowed to reach to
// correct a stream that was detected just before it arrived -- see the
// 'current-play' handler below.
const BACKFILL_WINDOW_MS = 4000;

// Per-tab pause flag set by the popup while it programmatically scrolls the
// ag-grid to capture every row (see captureFullGrid in popup.js). While
// paused, onBeforeRequest ignores NEW stream URLs so the scroll-induced
// clip loads don't pollute the detected-streams list. Already-known URLs
// are still allowed through (re-renders of the same clip are dedup'd).
const detectionPausedByTab = {};

// tabId -> { running, finished, percent, label, done, total } -- the live
// progress of that tab's Download All run, if any (see runDownloadAll).
// Lives here, not in the popup, specifically so the run survives the popup
// closing (which Chrome does the instant the user clicks anywhere outside
// it): the walk and the downloads are driven entirely from this service
// worker, which has its own lifecycle independent of any popup. A reopened
// popup reads this via the 'get-download-all-status' message to show
// current progress instead of a blank/reset UI; while open, it also gets
// live 'download-all-progress' broadcasts (see broadcast() below).
const downloadAllStateByTab = {};

// Pick the play report whose timestamp is the latest one at or before the
// stream's request time -- the play that was on screen when the request
// fired. Returns null if every known report is newer than the request (no
// report has landed yet, e.g. the very first clip of the session, or Hudl
// fired the network request before its own toolbar/grid finished updating
// to the new play) -- a stale, unrelated report is worse than no snapshot
// at all, since nameAndMetaFor treats "no snapshot" as "fall back to an
// index suffix instead of a wrong play number". The "fired before the
// update landed" case is corrected after the fact when that update does
// arrive -- see the backfill in the 'current-play' handler below.
function snapshotForStream(tabId, requestTime) {
  const hist = playHistoryByTab[tabId];
  if (!hist || !hist.length) return null;
  let best = null;
  for (const r of hist) {
    if (r.time <= requestTime) best = r;
    else break;
  }
  return best;
}

// Not every platform delivers video as an HLS/DASH manifest -- some (Hudl
// included, based on the direct .mp4 paths in its own page-export data)
// just serve one progressive video file per quality tier. So this
// classifies three cases instead of assuming manifest-based delivery:
//  - 'hls' / 'dash': a playlist that needs to be fetched and parsed for
//    segment URLs (see runJob).
//  - 'progressive': a single playable file that can be downloaded directly,
//    identified either by its extension or (for an opaque, extensionless
//    CDN URL) by Chrome tagging the request as a <video>/<audio> element's
//    own network fetch.
function classifyMediaUrl(details) {
  const url = details.url;
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (/\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(url)) return 'progressive';
  if (details.type === 'media') return 'progressive';
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const type = classifyMediaUrl(details);
    if (!type) return;
    const list = streamsByTab[details.tabId] || (streamsByTab[details.tabId] = []);
    const known = list.some((s) => s.url === details.url);
    // While the popup is scrolling the ag-grid to capture every row, ignore
    // NEW stream URLs so scroll-induced clip loads don't pollute the list.
    // Re-renders of an already-known URL pass through (they're dedup'd below).
    if (!known && detectionPausedByTab[details.tabId]) return;
    if (!known) {
      // The play that was on screen at the moment this request fired,
      // found by timestamp in the report history (see snapshotForStream) --
      // the real-time correlation, not a positional guess.
      const playSnapshot = snapshotForStream(details.tabId, Date.now());
      list.push({ url: details.url, type, time: Date.now(), playSnapshot });
      chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) });
      chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: '#ff6a1a' });
      // Hudl keeps prefetching clips after the page first loads, so the
      // popup's own stream list/count (a one-time snapshot from whenever it
      // happened to open) can go stale within seconds -- it looked "wrong"
      // (showing 4 when 8 clips eventually get detected) even though
      // Download All was always correct, since that re-reads streamsByTab
      // fresh right before downloading. Broadcasting here lets an open
      // popup stay live instead of only ever showing what was true the
      // instant it opened.
      chrome.runtime.sendMessage({ type: 'streams-updated', tabId: details.tabId, count: list.length }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete streamsByTab[tabId];
  delete playHistoryByTab[tabId];
  delete detectionPausedByTab[tabId];
  delete downloadAllStateByTab[tabId];
});

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

// mimeType matters beyond just labeling the bytes correctly: Chrome's
// downloads API has been observed correcting a download's filename
// extension to match a mismatched data: URL MIME type (a .meta.json
// filename saved as text/plain came back down as .meta.txt on disk) --
// so the sidecar JSON below is explicitly saved as application/json to
// keep the .json extension the Film Room viewer expects.
function toDataUrl(text, mimeType) {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return 'data:' + (mimeType || 'text/plain') + ';base64,' + b64;
}

// Saves whatever page metadata (play number, and any tables/label-value
// pairs scraped off the page) was captured for this clip as a sidecar JSON
// next to the video, named to match it -- so the Film Room player can find
// and display it. Skips writing anything if nothing useful was found.
async function savePlayInfo(folder, filenameBase, playInfo) {
  const hasFields = playInfo && playInfo.fields && Object.keys(playInfo.fields).length;
  const hasTables = playInfo && playInfo.tables && playInfo.tables.length;
  const hasGrid = playInfo && playInfo.gridRows && playInfo.gridRows.some((r) => r);
  if (!playInfo || (!playInfo.playLabel && !hasFields && !hasTables && !hasGrid)) return;

  const payload = {
    version: 1,
    capturedAt: new Date().toISOString(),
    videoId: playInfo.videoId || null,
    playLabel: playInfo.playLabel || null,
    pageTitle: playInfo.pageTitle || null,
    fields: playInfo.fields || {},
    tables: playInfo.tables || [],
    // The full play-by-play table (ag-grid rows scraped off the source page).
    // May be sparse (null entries) where ag-grid virtualized rows out of view.
    gridRows: playInfo.gridRows || [],
    // Which correlation strategy actually produced `fields`/`playLabel` for
    // this clip (see nameAndMetaFor in popup.js) -- and, for Download All,
    // extra detail (see the Download All handler) -- so a wrong name can be
    // root-caused straight from this file instead of re-deriving it blind.
    correlationSource: playInfo.correlationSource || null,
    debug: playInfo.debug || null,
  };
  await downloadFile(toDataUrl(JSON.stringify(payload, null, 2), 'application/json'), `${folder}/${filenameBase}.meta.json`);
}

async function runProgressiveJob(jobId, fileUrl, folder, fileBase, post, playInfo) {
  const ext = (fileUrl.split('?')[0].match(/\.(\w+)$/) || [, 'mp4'])[1];
  post({ status: 'downloading', done: 0, total: 1 });
  await downloadFile(fileUrl, `${folder}/${fileBase}.${ext}`);
  post({ status: 'downloading', done: 1, total: 1 });
  await savePlayInfo(folder, fileBase, playInfo);
  // No manifest, no segments -- it's already a single playable file, so
  // there's nothing for remux.js to do.
  post({ status: 'done', folder, noRemuxNeeded: true });
}

// `sharedFolder`, when set (by "Download All"), names one folder that every
// stream from that run gets saved into together -- so the whole batch (clips
// + .meta.json sidecars) is a single folder the Film Room web viewer can
// load in one "Open Folder…" pick, rather than one folder per stream.
// `dateFolder` (mm-dd-yyyy_HH-mm) is the first-level folder under
// FilmRoomDownloads/, naming when the download was initiated, so downloads
// started on different days end up clearly separated.
async function runJob(jobId, manifestUrl, title, streamType, playInfo, sharedFolder, dateFolder) {
  const post = (patch) => chrome.runtime.sendMessage({ type: 'job-progress', jobId, ...patch }).catch(() => {});
  const fileBase = slugify(title);
  const dateSeg = dateFolder || downloadDateFolder(new Date());
  const folder = 'FilmRoomDownloads/' + dateSeg + '/' + (sharedFolder ? slugify(sharedFolder) : fileBase);

  if (streamType === 'progressive') {
    try {
      await runProgressiveJob(jobId, manifestUrl, folder, fileBase, post, playInfo);
    } catch (err) {
      post({ status: 'error', message: String(err && err.message ? err.message : err) });
    }
    return;
  }

  // HLS/DASH segments are named generically (seg-00000.ts, init.mp4, ...),
  // so when several streams share one folder they get their own
  // fileBase-named subfolder to avoid colliding with each other; a lone
  // download just uses its folder directly, unchanged from before.
  const segFolder = sharedFolder ? `${folder}/${fileBase}` : folder;
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
      await downloadFile(initUrl, `${segFolder}/${name}`);
      localNames.push(name);
      done += 1;
      post({ status: 'downloading', done, total });
    }

    for (let i = 0; i < segments.length; i++) {
      const segUrl = segments[i];
      const ext = (segUrl.split('?')[0].match(/\.(\w+)$/) || [, 'ts'])[1];
      const name = `seg-${String(i).padStart(5, '0')}.${ext}`;
      await downloadFile(segUrl, `${segFolder}/${name}`);
      localNames.push(name);
      done += 1;
      post({ status: 'downloading', done, total });
    }

    const concatList = localNames
      .filter((n) => !n.startsWith('init.'))
      .map((n) => `file '${n}'`)
      .join('\n') + '\n';
    await downloadFile(toDataUrl(concatList), `${segFolder}/concat_list.txt`);
    // Named to match remux.js's default output filename (output.mp4).
    await savePlayInfo(segFolder, 'output', playInfo);

    post({ status: 'done', folder: segFolder });
  } catch (err) {
    post({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

// Drives the "Download All" walk and starts every stream's download job,
// entirely from this service worker -- see the comment on
// downloadAllStateByTab above for why: unlike the popup, this keeps running
// (and the on-page overlay + downloadAllStateByTab keep updating) no matter
// what the popup does, including closing. Uses extractHudlMetadata,
// rewindHudlClips, hudlWalkStep, restoreHudlPosition, updateFilmRoomOverlay,
// nameAndMetaFor, normalizeStreamUrl, makeSemaphore, slugify, and
// downloadDateFolder from download-all.js (see its own comments for the
// reasoning behind the walk/matching/fallback strategy itself -- this
// function is the same orchestration that used to live in popup.js's
// Download All click handler, just moved here so it survives the popup).
let jobCounter = 0;
async function runDownloadAll(tabId) {
  const existing = downloadAllStateByTab[tabId];
  if (existing && existing.running) return; // already in progress for this tab -- ignore a duplicate trigger

  const currentStreams = streamsByTab[tabId] || [];
  if (!currentStreams.length) return;

  const state = { running: true, finished: false, percent: 0, label: 'Starting…', done: 0, total: currentStreams.length };
  downloadAllStateByTab[tabId] = state;
  const broadcast = () => chrome.runtime.sendMessage({ type: 'download-all-progress', tabId, ...state }).catch(() => {});
  broadcast();

  const execInHudlPage = async (func, args) => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: args || [] });
      return result;
    } catch (e) {
      return null;
    }
  };

  const dateFolder = downloadDateFolder(new Date());

  // fullGrid: scroll-walk the ag-grid to capture every row (defeats
  // virtualization) so the positional naming fallback has the complete
  // play-by-play table. Detection is paused around this so scroll-induced
  // clip loads don't add spurious entries to streamsByTab.
  let meta = { videoId: null, playLabel: null, pageTitle: null, fields: {}, tables: [], gridRows: [] };
  detectionPausedByTab[tabId] = true;
  try {
    const result = await execInHudlPage(extractHudlMetadata, [{ fullGrid: true }]);
    if (result) meta = result;
  } finally {
    delete detectionPausedByTab[tabId];
  }
  const { name: baseName } = nameAndMetaFor(meta, null);

  // Re-read streamsByTab: the grid scroll above may itself have surfaced a
  // clip whose video hadn't been requested yet when this run started.
  const streams = streamsByTab[tabId] || currentStreams;

  // Fallback signal for any stream the walk below doesn't directly match
  // (e.g. an extra camera-angle stream whose video element the walk never
  // surfaced, or a page with no clip navigator at all). Only trust a
  // stream's real-time snapshot if its timestamp is UNIQUE within this
  // batch -- checked per stream, not batch-wide. A batch-wide "does at
  // least one pair of streams differ" check is wrong: in practice the very
  // first stream detected on page load often gets its own earlier,
  // genuinely one-off snapshot, while everything Hudl pre-fetches moments
  // later all shares one single later snapshot -- that one early outlier
  // would be enough to flip a batch-wide flag to "trust everything,"
  // letting the other streams' shared (wrong) snapshot through instead of
  // falling back to positional grid-row matching. Counting per timestamp
  // value fixes that: only a stream whose own snapshot time appears
  // exactly once gets treated as real per-clip correlation.
  const snapshotTimeCounts = new Map();
  for (const s of streams) {
    const t = s.playSnapshot && s.playSnapshot.time;
    if (t) snapshotTimeCounts.set(t, (snapshotTimeCounts.get(t) || 0) + 1);
  }

  // matched[i]: has stream i already had a download started for it (either
  // an exact walk match, or the fallback chain after the walk finishes)?
  // sem caps how many downloads run at once (2 at a time), but -- unlike
  // waiting for the whole walk to finish first, then downloading everything
  // -- jobs get queued as soon as each clip is walked, so downloading
  // overlaps with the rest of the walk instead of running after it.
  const matched = new Array(streams.length).fill(false);
  const sem = makeSemaphore(2);
  const jobs = [];
  let walkTotal = 0; // set once the walk's rewind step reports how many clips there are
  let walkStepsDone = 0;

  // Single combined progress signal for BOTH the broadcast to any open
  // popup and the on-page overlay -- walking and downloading happen
  // concurrently, so "N/M streams downloaded" alone would freeze at 0
  // while the walk is still in its early clips. Treat each walk step and
  // each finished download as one unit of a combined total, so the bar
  // advances continuously through both phases and reaches 100% exactly
  // when everything is actually done.
  const updateOverall = () => {
    const totalUnits = walkTotal + streams.length;
    const percent = totalUnits ? Math.round(((walkStepsDone + state.done) / totalUnits) * 100) : 0;
    const parts = [];
    // Only show "Walking clip N/M" while walking is actually still in
    // progress -- once walkStepsDone reaches walkTotal, dropping this line
    // avoids it reading as "still walking" while what's actually happening
    // (and can legitimately take a while: real file transfer time for
    // however many video files, bandwidth-bound) is just the downloads.
    if (walkTotal && walkStepsDone < walkTotal) parts.push(`Walking clip ${walkStepsDone}/${walkTotal}`);
    parts.push(`Downloaded ${state.done}/${streams.length}`);
    const label = parts.join(' · ');
    state.percent = percent;
    state.label = label;
    state.total = streams.length;
    broadcast();
    // Fire-and-forget: a slow/failed overlay update must never delay the
    // actual walk or downloads.
    execInHudlPage(updateFilmRoomOverlay, [{ label, percent, done: percent >= 100 }]).catch(() => {});
  };
  updateOverall();

  const startDownloadFor = (streamIndex, streamSnapshot, debugExtra) => {
    if (matched[streamIndex]) return;
    matched[streamIndex] = true;
    const s = streams[streamIndex];
    const { name: rowName, meta: rowMeta } = nameAndMetaFor(meta, streamIndex, streamSnapshot);
    rowMeta.debug = { streamIndex, streamUrl: s.url, ...debugExtra };
    const finalName = rowMeta.playLabel ? rowName : `${rowName}-${streamIndex + 1}`;
    jobs.push(
      (async () => {
        const release = await sem.acquire();
        try {
          await runJob('dlall-' + tabId + '-' + streamIndex + '-' + Date.now() + '-' + jobCounter++, s.url, finalName, s.type, rowMeta, baseName, dateFolder);
        } finally {
          release();
          state.done++;
          updateOverall();
        }
      })()
    );
  };

  // Actively walk every clip in Hudl's reel navigator instead of
  // correlating from passively-observed network timing or a positional
  // guess -- this briefly drives the page's own clip-to-clip navigation and
  // reads each clip's play data plus its video element's exact resolved
  // URL directly, so the match below is exact, not an assumption about
  // ordering. Each step's matched stream (if any) starts downloading
  // immediately rather than waiting for the walk to finish.
  const walkResults = [];
  const walkStartedAt = Date.now();
  const rewind = await execInHudlPage(rewindHudlClips);
  const rewindMs = Date.now() - walkStartedAt;
  if (rewind && rewind.total) {
    walkTotal = rewind.total;
    updateOverall(); // bar now has a real denominator instead of just the download count
    let lastVideoUrl = null;
    for (let i = 1; i <= rewind.total; i++) {
      const hasNext = i < rewind.total;
      const step = await execInHudlPage(hudlWalkStep, [lastVideoUrl, hasNext]);
      if (!step) break; // scripting was refused mid-walk -- stop; whatever matched so far still downloads
      lastVideoUrl = step.videoUrl || lastVideoUrl;
      walkResults.push(step);
      walkStepsDone = i;
      updateOverall();
      if (step.videoUrl) {
        const key = normalizeStreamUrl(step.videoUrl);
        const idx = streams.findIndex((s, si) => !matched[si] && normalizeStreamUrl(s.url) === key);
        if (idx !== -1) {
          startDownloadFor(idx, { fields: step.fields, source: 'walk-url-match' }, { walkMatched: true, walkedVideoUrl: step.videoUrl });
        }
      }
    }
    // Fire-and-forget: restoring the user's original position must never
    // delay a download that's already queued or in flight.
    execInHudlPage(restoreHudlPosition, [rewind.initialIndex]).catch(() => {});
  }

  // Diagnostics -- lets a wrong name be root-caused (walkDistinctVideoUrls:
  // 1 would mean the walk's video element never actually changed across
  // clips even though the counter/fields did), and per-step timing says
  // exactly which step(s) are slow (waitedMs close to the 3000ms cap means
  // that step's video never actually swapped in time, not just "slow").
  console.log('[FilmRoom] walk results:', walkResults);
  console.log(
    '[FilmRoom] walkDistinctVideoUrls:',
    new Set(walkResults.map((w) => w.videoUrl).filter(Boolean)).size,
    'snapshotTimeCounts:',
    snapshotTimeCounts
  );
  console.log(
    '[FilmRoom] walk timing: rewindMs=%d totalWalkMs=%d steps=%o',
    rewindMs,
    Date.now() - walkStartedAt,
    walkResults.map((w) => w.waitedMs)
  );

  // Anything the walk didn't match (no clip navigator on this page, an
  // extra camera-angle stream, etc.) falls back to the real-time snapshot
  // (only when trustworthy -- see snapshotTimeCounts above), then
  // positional grid-row matching, then an index suffix rather than a wrong
  // play number when nothing matched at all (see nameAndMetaFor).
  streams.forEach((s, i) => {
    if (matched[i]) return;
    const snapTime = s.playSnapshot && s.playSnapshot.time;
    const trustThisSnapshot = streams.length <= 1 || (snapTime && snapshotTimeCounts.get(snapTime) === 1);
    startDownloadFor(i, trustThisSnapshot ? s.playSnapshot : null, {
      walkMatched: false,
      snapshotTime: snapTime || null,
      snapshotSharedByCount: snapTime ? snapshotTimeCounts.get(snapTime) : null,
      trustThisSnapshot,
    });
  });

  await Promise.all(jobs);
  state.running = false;
  state.finished = true;
  state.percent = 100;
  state.label = `All ${streams.length} streams downloaded to Downloads/FilmRoomDownloads/${dateFolder}/${slugify(baseName)}.`;
  broadcast();
  execInHudlPage(updateFilmRoomOverlay, [{ label: 'Done — all clips downloaded', percent: 100, done: true }]).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'current-play') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      const report = { playNumber: msg.playNumber, fields: msg.fields, time: msg.time };
      const hist = playHistoryByTab[tabId] || (playHistoryByTab[tabId] = []);
      hist.push(report);
      if (hist.length > MAX_PLAY_HISTORY) hist.splice(0, hist.length - MAX_PLAY_HISTORY);

      // Backfill: onBeforeRequest tags a stream with snapshotForStream() the
      // instant it's detected, using only reports that have landed by then.
      // If Hudl fires a newly-loaded clip's network request before its own
      // toolbar/grid re-renders to reflect that clip's play, the stream gets
      // tagged with the PREVIOUS play's snapshot (or none at all) -- exactly
      // the "downloaded clip name doesn't match the play number on screen"
      // symptom. This report may be the update that request was waiting on,
      // so retroactively re-tag any very-recently-detected stream on this
      // tab if this report is a better match than what it currently has:
      // either it has none, or this report's timestamp is closer to the
      // stream's own detection time than its current snapshot's is.
      const list = streamsByTab[tabId];
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          const s = list[i];
          if (report.time - s.time > BACKFILL_WINDOW_MS) break; // list is detection-order, so older entries only get further away
          const currentGap = s.playSnapshot ? Math.abs(s.playSnapshot.time - s.time) : Infinity;
          const reportGap = Math.abs(report.time - s.time);
          if (reportGap < currentGap) s.playSnapshot = report;
        }
      }
    }
    return;
  }
  if (msg.type === 'pause-detection') {
    detectionPausedByTab[msg.tabId] = true;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'resume-detection') {
    delete detectionPausedByTab[msg.tabId];
    sendResponse({ ok: true });
    return true;
  }
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
    runJob(msg.jobId, msg.manifestUrl, msg.title, msg.streamType, msg.playInfo, msg.folder, msg.dateFolder);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'start-download-all') {
    runDownloadAll(msg.tabId); // fire-and-forget -- see runDownloadAll's own comment for why this runs here, not in the popup
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'get-download-all-status') {
    sendResponse({ state: downloadAllStateByTab[msg.tabId] || null });
    return true;
  }
});
