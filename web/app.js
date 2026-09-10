// Film Room app controller -- extracted from web/index.html so it can load
// under the extension's strict CSP (script-src 'self'), which blocks inline
// <script> blocks. Loaded as an external script after shared/player.js and
// shared/play-info.js, which define TelestrationPlayer and PlayInfo.
(function () {
  const video = document.getElementById('video');
  const canvas = document.getElementById('overlay');
  const placeholder = document.getElementById('placeholder');
  const player = new TelestrationPlayer({ video, canvas });

  // ---- library ----
  const clipList = document.getElementById('clipList');
  const playInfoEl = document.getElementById('playInfo');
  const clips = []; // { name, url, key }
  const metaByBase = {}; // basename (no extension) -> parsed .meta.json content
  let activeIndex = -1;

  // "Play-12-v97953713.mp4" and "Play-12-v97953713.meta.json" (the
  // downloader extension's naming convention) share this same base. Also
  // accepts ".meta.txt": Chrome's downloads API has been observed silently
  // renaming the sidecar's extension from .json to .txt (it saves the
  // sidecar as a data:text/plain URL, and appears to correct the filename
  // to match that MIME type) -- the content is still plain JSON either way,
  // so this matches both rather than losing already-downloaded sidecars.
  function clipBaseName(filename) {
    const metaStripped = filename.replace(/\.meta\.(json|txt)$/i, '');
    const base = metaStripped !== filename ? metaStripped : filename.replace(/\.[^.]+$/, '');
    // Chrome's downloads API appends " (1)", " (2)", ... to whichever half
    // of a video/sidecar pair happens to collide with a file already in
    // that folder (e.g. re-running a download into the same dated folder) --
    // only the one that collided gets suffixed, so the pair can otherwise
    // end up on two different basenames despite belonging together.
    // Stripping it before matching keeps them paired regardless of which
    // half (if either) got uniquified.
    return base.replace(/ \(\d+\)$/, '');
  }

  function renderPlayInfoForActive() {
    const clip = clips[activeIndex];
    if (!clip) {
      // Nothing selected yet -- unlike a selected clip with no sidecar,
      // there's no "play" to show info for at all, so the panel itself
      // stays hidden rather than showing a "no play info" placeholder.
      playInfoEl.innerHTML = '';
      playInfoEl.hidden = true;
      return;
    }
    PlayInfo.renderPlayInfo(playInfoEl, metaByBase[clipBaseName(clip.name)]);
  }

  function notesStorageKey(clipKey) {
    return 'filmroom.notes.' + clipKey;
  }

  function loadNotesForActiveClip() {
    const clip = clips[activeIndex];
    if (!clip) return;
    try {
      const raw = localStorage.getItem(notesStorageKey(clip.key));
      if (raw) {
        player.loadNotes(JSON.parse(raw));
        return;
      }
    } catch (e) {}
    player.clearAllNotes();
  }

  function saveNotesForActiveClip() {
    const clip = clips[activeIndex];
    if (!clip) return;
    try {
      localStorage.setItem(notesStorageKey(clip.key), JSON.stringify(player.serializeNotes()));
    } catch (e) {}
  }

  function renderClips() {
    clipList.innerHTML = '';
    if (clips.length === 0) {
      clipList.innerHTML = '<div class="empty-hint">No clips loaded yet. Click "Open Folder…" and pick the FilmRoomDownloads folder you downloaded.</div>';
      return;
    }
    clips.forEach((clip, i) => {
      const el = document.createElement('div');
      el.className = 'clip-item' + (i === activeIndex ? ' active' : '');
      el.textContent = clip.name;
      el.addEventListener('click', () => selectClip(i));
      clipList.appendChild(el);
    });
  }

  function selectClip(i) {
    activeIndex = i;
    placeholder.style.display = 'none';
    player.load(clips[i].url);
    loadNotesForActiveClip();
    renderPlayInfoForActive();
    renderClips();
  }

  const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;
  // See the comment on clipBaseName above -- Chrome has been observed
  // renaming these to .meta.txt, so both are accepted here too.
  const META_RE = /\.meta\.(json|txt)$/i;

  // Shared by both pickers: a plain multi-file select (files may be
  // anything the accept filter let through) and a whole-folder select
  // (webkitdirectory hands back every file under the folder, recursively,
  // with no extension filtering at all -- so this always filters by
  // extension itself rather than trusting the source).
  async function handleFileList(fileList) {
    const files = Array.from(fileList || []);
    const metaFiles = files.filter((f) => META_RE.test(f.name));
    const videoFiles = files.filter((f) => VIDEO_EXT_RE.test(f.name));
    // Folder selects don't come back in a guaranteed order across
    // OSes/browsers; sort each incoming batch so e.g. Play-2 comes before
    // Play-10 in the sidebar.
    videoFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const f of metaFiles) {
      try {
        metaByBase[clipBaseName(f.name)] = JSON.parse(await f.text());
      } catch (err) {
        console.warn('Could not parse play-info file', f.name, err);
      }
    }

    videoFiles.forEach((f) => clips.push({
      name: f.name,
      url: URL.createObjectURL(f),
      key: f.name + '|' + f.size + '|' + f.lastModified,
    }));
    renderClips();
    if (activeIndex === -1 && clips.length) selectClip(0);
    else renderPlayInfoForActive(); // meta may have arrived after its video was already active
  }

  document.getElementById('openFiles').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });
  // dirHandle.values() only lists that directory's own immediate entries --
  // it does NOT descend into subdirectories on its own. Downloads land at
  // FilmRoomDownloads/<date>/<name>/<clip files>, so picking anything above
  // the innermost <name> folder (very plausible: the folder-open hint just
  // says "pick the FilmRoomDownloads folder") would silently find zero
  // files without this recursing into every nested directory itself.
  async function collectFilesRecursively(dirHandle, files) {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') files.push(await entry.getFile());
      else if (entry.kind === 'directory') await collectFilesRecursively(entry, files);
    }
  }

  document.getElementById('openFolder').addEventListener('click', async () => {
    // Three strategies, best-first:
    //  1. File System Access API (showDirectoryPicker) -- desktop Chromium,
    //     best UX (real folder picker, reads subdirectories).
    //  2. <input webkitdirectory> -- desktop Chrome/Edge/Firefox/Safari.
    //  3. Multi-file <input multiple> -- the only thing iOS Safari supports;
    //     webkitdirectory is silently ignored on iOS, so without this
    //     fallback "Open Folder…" would do nothing on iPhone/iPad.
    //
    // showDirectoryPicker is gated to secure contexts, and chrome-extension://
    // pages ARE secure contexts -- so the API is *defined* there -- but Chrome
    // blocks it from actually running in extension pages: the call rejects
    // with a SecurityError. That rejection happens after an `await`, which
    // consumes the click's transient user-activation, so the webkitdirectory
    // fallback's programmatic folderInput.click() would then fire with no user
    // gesture left and silently do nothing (the "Open Folder does nothing
    // when launched from the extension button" bug). So we skip strategy 1
    // entirely in extension pages and go straight to the working fallback.
    const inExtensionPage = location.protocol === 'chrome-extension:';
    if (window.showDirectoryPicker && !inExtensionPage) {
      try {
        const dirHandle = await window.showDirectoryPicker();
        const files = [];
        await collectFilesRecursively(dirHandle, files);
        if (files.length) handleFileList(files);
        return;
      } catch (e) { /* user cancelled -- fall through to next strategy */ }
    }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const folderInput = document.getElementById('folderInput');
    const supportsWebkitDir = !isIOS && (function () {
      const i = document.createElement('input');
      i.type = 'file';
      try { i.webkitdirectory = true; } catch (e) {}
      return i.webkitdirectory === true;
    })();
    if (supportsWebkitDir) {
      folderInput.click();
    } else {
      // iOS: no folder picker exists -- use the multi-file picker so the
      // user can select all the clips + .meta.json files from Files app.
      document.getElementById('fileInput').click();
    }
  });

  document.getElementById('fileInput').addEventListener('change', (e) => {
    handleFileList(e.target.files);
    e.target.value = '';
  });
  document.getElementById('folderInput').addEventListener('change', (e) => {
    handleFileList(e.target.files);
    e.target.value = '';
  });

  // ---- transport controls ----
  const playPause = document.getElementById('playPause');
  video.addEventListener('play', () => (playPause.textContent = 'Pause'));
  video.addEventListener('pause', () => (playPause.textContent = 'Play'));
  playPause.addEventListener('click', () => player.togglePlay());

  document.getElementById('skipBack').addEventListener('click', () => player.seekBy(-5));
  document.getElementById('skipFwd').addEventListener('click', () => player.seekBy(5));
  document.getElementById('frameBack').addEventListener('click', () => player.stepFrame(-1));
  document.getElementById('frameFwd').addEventListener('click', () => player.stepFrame(1));

  document.getElementById('speedSelect').addEventListener('change', (e) => {
    player.setSpeed(parseFloat(e.target.value));
  });
  document.getElementById('fpsSelect').addEventListener('change', (e) => {
    player.setFps(parseInt(e.target.value, 10));
  });

  // ---- fullscreen ----
  // Fullscreens the whole main pane (telestration bar, video + overlay,
  // notes, transport controls) rather than just the <video> -- so drawing
  // tools and playback controls stay usable while fullscreen, not just raw
  // video playback.
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const fullscreenTarget = document.getElementById('main');

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenBtn() {
    fullscreenBtn.textContent = isFullscreen() ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
  }

  if (fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen) {
    fullscreenBtn.addEventListener('click', () => {
      if (isFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen).call(fullscreenTarget);
      }
    });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((evt) => {
      document.addEventListener(evt, () => {
        updateFullscreenBtn();
        // Fullscreen transitions don't reliably fire a window 'resize'
        // event in every browser (Safari especially), but the canvas
        // overlay needs to rescale to the new element size -- player.js
        // already resizes on 'resize', so just piggy-back on that instead
        // of reaching into its private canvas-sizing method directly.
        window.dispatchEvent(new Event('resize'));
      });
    });
  } else {
    // Fullscreen API unavailable (older Safari/iOS) -- hide rather than
    // leave a dead button.
    fullscreenBtn.hidden = true;
  }

  function fmt(t) {
    if (!isFinite(t)) return '00:00';
    const m = Math.floor(t / 60).toString().padStart(2, '0');
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  const seekBar = document.getElementById('seekBar');
  const timeLabel = document.getElementById('timeLabel');
  let seeking = false;

  video.addEventListener('timeupdate', () => {
    if (seeking) return;
    const d = video.duration || 0;
    seekBar.value = d ? Math.round((video.currentTime / d) * 1000) : 0;
    timeLabel.textContent = fmt(video.currentTime) + ' / ' + fmt(d);
  });

  seekBar.addEventListener('input', () => {
    seeking = true;
    player.seekToFraction(seekBar.value / 1000);
  });
  seekBar.addEventListener('change', () => {
    seeking = false;
  });

  // ---- telestration controls ----
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      player.setTool(btn.dataset.tool);
    });
  });
  document.querySelector('[data-tool="pen"]').classList.add('active');

  document.querySelectorAll('.color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      player.setColor(btn.dataset.color);
    });
  });

  document.getElementById('lineWidth').addEventListener('input', (e) => {
    player.setLineWidth(parseInt(e.target.value, 10));
  });

  document.getElementById('undoBtn').addEventListener('click', () => player.undo());
  document.getElementById('clearBtn').addEventListener('click', () => player.clearVisibleNote());
  document.getElementById('snapshotBtn').addEventListener('click', () => {
    const dataUrl = player.snapshot();
    const a = document.createElement('a');
    a.href = dataUrl;
    const name = (clips[activeIndex] && clips[activeIndex].name.replace(/\.[^.]+$/, '')) || 'clip';
    a.download = name + '-snapshot.png';
    a.click();
  });

  // ---- notes: timestamped telestrations ----
  const notesChips = document.getElementById('notesChips');
  let currentNotes = [];

  function fmtMs(ms) {
    const total = ms / 1000;
    const m = Math.floor(total / 60).toString().padStart(2, '0');
    const s = (total % 60).toFixed(1).padStart(4, '0');
    return m + ':' + s;
  }

  function renderNoteChips() {
    notesChips.innerHTML = '';
    if (!currentNotes.length) {
      notesChips.innerHTML = '<span class="notes-label">None yet — draw while paused to create one.</span>';
      return;
    }
    const nowMs = video.currentTime * 1000;
    currentNotes.forEach((n) => {
      const chip = document.createElement('button');
      chip.className = 'note-chip' + (Math.abs(n.timeMs - nowMs) < 200 ? ' active' : '');
      chip.textContent = fmtMs(n.timeMs) + ' (' + n.strokeCount + ')';
      chip.addEventListener('click', () => player.seekToMs(n.timeMs));
      notesChips.appendChild(chip);
    });
  }

  player.onNotesChanged = (notes) => {
    currentNotes = notes;
    renderNoteChips();
    saveNotesForActiveClip();
  };
  video.addEventListener('timeupdate', renderNoteChips);
  video.addEventListener('seeked', renderNoteChips);
  renderNoteChips();

  document.getElementById('saveNotesBtn').addEventListener('click', () => {
    const data = player.serializeNotes();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = (clips[activeIndex] && clips[activeIndex].name.replace(/\.[^.]+$/, '')) || 'clip';
    a.download = name + '-notes.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('loadNotesBtn').addEventListener('click', () => {
    document.getElementById('notesFileInput').click();
  });
  document.getElementById('notesFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      player.loadNotes(data);
    } catch (err) {
      alert('Could not read that notes file: ' + err.message);
    }
  });

  // spacebar play/pause, arrow keys frame step
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      // If a button (e.g. the Play button just clicked) has focus, Space
      // would also fire that button's own click -> a double toggle that
      // cancels itself out and looks like the spacebar does nothing.
      // Blur it so only this handler runs.
      const ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON') ae.blur();
      player.togglePlay();
    }
    if (e.code === 'ArrowLeft') player.stepFrame(-1);
    if (e.code === 'ArrowRight') player.stepFrame(1);
  });
})();
