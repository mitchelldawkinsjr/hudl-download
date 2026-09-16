// Multi-angle player (Phase 6). Wraps two <video>/<canvas> pairs and a
// coordinator that keeps them in sync. Does NOT replace TelestrationPlayer;
// single-angle review still uses TelestrationPlayer. The Side by Side tab
// constructs one of these.
//
// Drift algorithm (constants configurable via opts):
//   sample via requestVideoFrameCallback (100ms timer fallback)
//   |drift| <= NOOP_MS        → no-op
//   |drift| <= NUDGE_MS       → ±5% playbackRate nudge on the follower
//   |drift| >  NUDGE_MS       → hard-seek follower to master + offset
// Shared controls seek/play/pause/speed/step both videos at
//   targetTime + syncOffsetMs/1000, wait for seek before resume; 2s
//   timeout → lagging angle buffering (pauseOnFollowerBuffer).
(function () {
  const DEFAULTS = {
    noOpMs: 80,
    nudgeMs: 200,
    nudgeRate: 0.05,
    sampleMs: 100,
    seekWaitMs: 2000,
    pauseOnFollowerBuffer: true,
  };

  function create(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    let videos = [];
    let canvases = [];
    let offsets = [0, 0];      // syncOffsetMs per angle (follower = master + offset)
    let master = 0;
    let raf = null;
    let timer = null;
    let lastSample = 0;
    let seeking = false;
    let onDrift = null;        // (driftMs) => void  // for tests/observability

    function attach({ videos: vs, canvases: cs }) {
      videos = vs;
      canvases = cs || [];
      master = 0;
    }

    function setOffsets(ms) { offsets = ms || [0, 0]; }
    function getOffsets() { return offsets.slice(); }

    // logical time = master currentTime (the shared clock). Each angle's
    // target = logicalTime + offset/1000.
    function logicalTime() { return videos[master]?.currentTime ?? 0; }

    function targetFor(i) { return logicalTime() + (offsets[i] || 0) / 1000; }

    async function seekBoth(logicalSec) {
      seeking = true;
      const targets = videos.map((_, i) => logicalSec + (offsets[i] || 0) / 1000);
      await Promise.all(videos.map((v, i) => {
        if (!v) return Promise.resolve();
        v.currentTime = Math.max(0, targets[i]);
        return waitForSeek(v);
      }));
      seeking = false;
    }

    function waitForSeek(v) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, cfg.seekWaitMs);
        const onSeeked = () => { clearTimeout(t); v.removeEventListener('seeked', onSeeked); resolve(); };
        v.addEventListener('seeked', onSeeked);
      });
    }

    async function play() {
      await Promise.all(videos.map((v) => v && v.play().catch(() => {})));
      startSync();
    }
    function pause() { videos.forEach((v) => v && v.pause()); stopSync(); }

    async function seekTo(logicalSec) { await seekBoth(logicalSec); }
    async function seekBy(delta) { await seekBoth(Math.max(0, logicalTime() + delta)); }
    function setSpeed(rate) { videos.forEach((v) => { if (v) v.playbackRate = rate; }); }

    // ---- drift correction ----
    function sample() {
      if (seeking) return schedule();
      const m = videos[master];
      const f = videos[1 - master];
      if (!m || !f) return schedule();
      const mTime = m.currentTime;
      const fExpected = mTime + (offsets[1 - master] - offsets[master]) / 1000;
      const drift = f.currentTime - fExpected;
      if (onDrift) try { onDrift(drift); } catch {}
      correct(drift);
      schedule();
    }

    function correct(drift) {
      const f = videos[1 - master];
      if (!f) return;
      const ad = Math.abs(drift);
      if (ad <= cfg.noOpMs) {
        f.playbackRate = videos[master]?.playbackRate || 1;
      } else if (ad <= cfg.nudgeMs) {
        f.playbackRate = (videos[master]?.playbackRate || 1) * (1 + (drift < 0 ? cfg.nudgeRate : -cfg.nudgeRate));
      } else {
        // hard seek follower
        const target = (videos[master]?.currentTime || 0) + (offsets[1 - master] - offsets[master]) / 1000;
        f.currentTime = Math.max(0, target);
        f.playbackRate = videos[master]?.playbackRate || 1;
      }
    }

    function schedule() {
      if (raf !== null) return;
      const v = videos[master];
      if (v && typeof v.requestVideoFrame === 'function') {
        raf = v.requestVideoFrame(() => { raf = null; sample(); });
      } else {
        timer = setTimeout(() => { timer = null; sample(); }, cfg.sampleMs);
      }
    }

    function startSync() {
      stopSync();
      sample();
    }
    function stopSync() {
      if (raf !== null && videos[master]?.cancelVideoFrame) { try { videos[master].cancelVideoFrame(raf); } catch {} }
      raf = null;
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function setMaster(i) { master = i; }
    function destroy() { stopSync(); }

    return {
      attach, setOffsets, getOffsets, logicalTime, targetFor,
      play, pause, seekTo, seekBy, setSpeed,
      startSync, stopSync, setMaster, destroy,
      set onDrift(cb) { onDrift = cb; }, get onDrift() { return onDrift; },
      get cfg() { return cfg; },
    };
  }

  window.MultiAnglePlayer = { create };
})();
