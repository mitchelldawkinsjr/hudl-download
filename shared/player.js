// Shared playback + telestration engine used by both the web app and the
// Electron app. Plain script (no ES modules) so it works when loaded from
// file:// in either shell.
(function (global) {
  const DEFAULT_FPS = 30;
  const NOTE_FORMAT_VERSION = 1;

  class TelestrationPlayer {
    constructor({ video, canvas }) {
      this.video = video;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.fps = DEFAULT_FPS;
      this.tool = 'pen';
      this.color = '#ff3b30';
      this.lineWidth = 4;

      // Telestration notes are timestamped: each note is only visible while
      // playback is at (or very near) the moment it was drawn at, and
      // disappears as soon as you move away from that timestamp.
      this.notes = []; // [{ timeMs, strokes: [...] }], sorted by timeMs
      this.activeNote = null; // the note currently being drawn into, if any
      this.currentStroke = null;
      this.drawing = false;
      this.onNotesChanged = null; // optional host callback: (notes) => void

      // Inline <input> shown over the canvas while placing a text
      // annotation -- { input, point } (point is the normalized placement
      // point), or null when no text box is currently being edited.
      this._textEditor = null;

      // Last playback position (ms) we measured, used by _checkNoteStop to
      // detect a note timestamp being crossed *between* two timeupdate
      // firings -- timeupdate only fires ~4x/sec, so without comparing the
      // previous position to the current one a note could be skipped over
      // entirely during forward playback.
      this._lastTimeMs = 0;

      this.video.addEventListener('loadedmetadata', () => this._resizeCanvas());
      this.video.addEventListener('timeupdate', () => {
        this._checkNoteStop();
        this._redraw();
      });
      this.video.addEventListener('seeked', () => this._redraw());
      // Any seek (programmatic or user scrub) resets the crossing baseline
      // to the new position, so notes the seek jumped *past* don't trigger
      // a spurious auto-pause on the next timeupdate.
      this.video.addEventListener('seeking', () => {
        this._lastTimeMs = this._currentTimeMs();
      });
      window.addEventListener('resize', () => this._resizeCanvas());
      this._bindCanvasEvents();
      this._resizeCanvas();
    }

    // ---------------- playback ----------------

    load(src) {
      this.video.src = src;
      this.video.load();
      // Reset silently (no onNotesChanged notification): the host is
      // expected to immediately follow this with loadNotes(...) for the
      // newly-selected clip. If we notified here, a host that persists on
      // every change (as both the web and Electron apps do) would write
      // this empty state to storage and clobber the saved notes before
      // they've had a chance to be read back in.
      this.notes = [];
      this.activeNote = null;
      this._lastTimeMs = 0;
      // Container size is known immediately from layout; don't wait on
      // metadata (which may be slow/never arrive) to size the canvas.
      requestAnimationFrame(() => this._resizeCanvas());
    }

    togglePlay() {
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    }

    seekBy(seconds) {
      // Fall back to Infinity (not 0!) when duration isn't known yet, so
      // this doesn't silently clamp to the start before metadata loads.
      const d = this.video.duration || Infinity;
      this.video.currentTime = Math.min(Math.max(0, this.video.currentTime + seconds), d);
      // Don't rely solely on the browser firing 'timeupdate'/'seeked' --
      // redraw immediately so the note overlay never lags a programmatic
      // seek.
      this._redraw();
    }

    stepFrame(dir) {
      this.video.pause();
      const step = dir / this.fps;
      const d = this.video.duration || Infinity;
      this.video.currentTime = Math.min(Math.max(0, this.video.currentTime + step), d);
      this._redraw();
    }

    setSpeed(rate) {
      this.video.playbackRate = rate;
    }

    setFps(fps) {
      this.fps = fps;
    }

    seekToFraction(fraction) {
      const d = this.video.duration || 0;
      this.video.currentTime = fraction * d;
      this._redraw();
    }

    seekToMs(ms) {
      this.video.pause();
      this.video.currentTime = ms / 1000;
      this._redraw();
    }

    // Auto-pause at note timestamps during forward playback: when playback
    // crosses a note's timestamp, stop exactly on it and stay paused until
    // the user presses play. Only forward playback triggers it -- seeking
    // backward (or seeking past a note while paused) is handled by the
    // `seeking` listener resetting _lastTimeMs, so it never looks like a
    // forward crossing. After pausing on a note, currentTime is snapped to
    // that note's exact time, so resuming won't immediately re-trigger the
    // same note (the next check sees prev == noteTime, and the crossing
    // test is strictly greater-than on the lower bound).
    _checkNoteStop() {
      const cur = this._currentTimeMs();
      const last = this._lastTimeMs;
      if (!this.video.paused && this.notes.length && cur > last) {
        // Earliest note strictly after `last` and at or before `cur`: the
        // first one playback reached since the last check.
        let stopAt = -1;
        for (const note of this.notes) {
          if (note.timeMs > last && note.timeMs <= cur) {
            if (stopAt < 0 || note.timeMs < stopAt) stopAt = note.timeMs;
          }
        }
        if (stopAt >= 0) {
          this.video.pause();
          this.video.currentTime = stopAt / 1000;
          this._lastTimeMs = stopAt;
          return;
        }
      }
      this._lastTimeMs = cur;
    }

    // ---------------- telestration ----------------

    setTool(tool) {
      this.tool = tool;
    }

    setColor(color) {
      this.color = color;
    }

    setLineWidth(w) {
      this.lineWidth = w;
    }

    // How close (in ms) playback has to be to a note's timestamp for that
    // note to be shown: about 1.5 frames at the current fps, with a floor
    // so scrubbing by hand can actually land on a note.
    _toleranceMs() {
      return Math.max(120, (1000 / this.fps) * 1.5);
    }

    _currentTimeMs() {
      return Math.round(this.video.currentTime * 1000);
    }

    // The note whose timestamp playback is currently within tolerance of,
    // or null if none.
    _visibleNote() {
      const t = this._currentTimeMs();
      const tol = this._toleranceMs();
      let best = null;
      let bestDist = Infinity;
      for (const note of this.notes) {
        const dist = Math.abs(note.timeMs - t);
        if (dist <= tol && dist < bestDist) {
          best = note;
          bestDist = dist;
        }
      }
      return best;
    }

    // Note strokes are appended to whatever note matches the current
    // playback timestamp; a new one is created if none exists yet.
    _noteForDrawing() {
      const t = this._currentTimeMs();
      let note = this.notes.find((n) => n.timeMs === t);
      if (!note) {
        note = { timeMs: t, strokes: [] };
        this.notes.push(note);
        this.notes.sort((a, b) => a.timeMs - b.timeMs);
      }
      return note;
    }

    undo() {
      const note = this._visibleNote();
      if (!note) return;
      note.strokes.pop();
      if (note.strokes.length === 0) {
        this.notes = this.notes.filter((n) => n !== note);
      }
      this._notifyNotesChanged();
      this._redraw();
    }

    // Clears only the note visible right now, leaving other timestamps
    // untouched.
    clearVisibleNote() {
      const note = this._visibleNote();
      if (!note) return;
      this.notes = this.notes.filter((n) => n !== note);
      this._notifyNotesChanged();
      this._redraw();
    }

    clearAllNotes() {
      this.notes = [];
      this.activeNote = null;
      this._notifyNotesChanged();
      this._redraw();
    }

    hasVisibleNote() {
      return !!this._visibleNote();
    }

    listNotes() {
      // Shallow copy, sorted, for host UI (e.g. a jump-to-note list).
      return this.notes.map((n) => ({ timeMs: n.timeMs, strokeCount: n.strokes.length }));
    }

    // Serialize all notes to a plain JSON-able object. Points are stored
    // normalized (0..1) so they replay correctly regardless of window size.
    serializeNotes() {
      return {
        version: NOTE_FORMAT_VERSION,
        fps: this.fps,
        notes: this.notes.map((n) => ({ timeMs: n.timeMs, strokes: n.strokes })),
      };
    }

    loadNotes(data) {
      if (!data || !Array.isArray(data.notes)) return;
      this.notes = data.notes
        .map((n) => ({ timeMs: n.timeMs, strokes: n.strokes || [] }))
        .sort((a, b) => a.timeMs - b.timeMs);
      this._notifyNotesChanged();
      this._redraw();
    }

    _notifyNotesChanged() {
      if (typeof this.onNotesChanged === 'function') this.onNotesChanged(this.listNotes());
    }

    snapshot() {
      const off = document.createElement('canvas');
      off.width = this.video.videoWidth || this.canvas.width;
      off.height = this.video.videoHeight || this.canvas.height;
      const octx = off.getContext('2d');
      octx.drawImage(this.video, 0, 0, off.width, off.height);
      octx.drawImage(this.canvas, 0, 0, off.width, off.height);
      return off.toDataURL('image/png');
    }

    _resizeCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      this._redraw();
    }

    _bindCanvasEvents() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => {
        // Freeze playback at the instant drawing starts. Without this, a
        // stroke drawn while the video keeps playing gets stamped with its
        // start timestamp but finishes (and is redrawn) once currentTime
        // has already moved past the visibility tolerance -- so it vanishes
        // the moment you lift the pen, which is the "doesn't show" bug.
        this.video.pause();

        // Text is a click-to-place inline text box, not a drag gesture --
        // handled entirely separately from the pointermove/pointerup drag
        // lifecycle below.
        if (this.tool === 'text') {
          // A real (trusted) mousedown's default action moves focus to the
          // nearest focusable ancestor of its target -- canvas isn't
          // focusable, so that default steals focus right back (to <body>)
          // immediately after _startTextInput below focuses the new input,
          // which fires the input's blur handler and commits it empty
          // before a single character can be typed. preventDefault() here
          // suppresses that default focus change so our own focus() sticks.
          e.preventDefault();
          this._startTextInput(e, this._point(e));
          return;
        }

        c.setPointerCapture(e.pointerId);
        this.drawing = true;
        this.activeNote = this._noteForDrawing();
        const p = this._point(e);
        this.currentStroke = {
          tool: this.tool,
          color: this.color,
          width: this.lineWidth,
          points: [p],
        };
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.drawing || !this.currentStroke) return;
        const p = this._point(e);
        if (this.tool === 'pen') this.currentStroke.points.push(p);
        else this.currentStroke.points[1] = p;
        this._redraw(true);
      });
      const end = () => {
        if (!this.drawing) return;
        this.drawing = false;
        if (this.currentStroke && this.currentStroke.points.length > 1 && this.activeNote) {
          this.activeNote.strokes.push(this.currentStroke);
          this._notifyNotesChanged();
        }
        this.currentStroke = null;
        this.activeNote = null;
        this._redraw();
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
    }

    // Places an inline <input> over the canvas at the clicked position, so
    // the user can type a text annotation in place rather than through a
    // blocking prompt() dialog. Committed (turned into a real "text" stroke
    // on the visible note) on Enter or on blur -- so simply clicking away
    // (a toolbar button, another point on the canvas) commits whatever was
    // typed, same as any other inline-edit UI.
    _startTextInput(e, point) {
      if (this._textEditor) this._commitTextEditor();

      const wrap = this.canvas.parentElement;
      const rect = this.canvas.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'telestration-text-input';
      input.style.left = (rect.left - wrapRect.left + point.x * rect.width) + 'px';
      input.style.top = (rect.top - wrapRect.top + point.y * rect.height) + 'px';
      input.style.color = this.color;
      input.style.fontSize = Math.max(12, this.lineWidth * 4) + 'px';

      const commit = () => this._commitTextEditor();
      input.addEventListener('keydown', (ev) => {
        // Stop the page-level spacebar/arrow-key shortcuts (play/pause,
        // frame step) from firing while the user is typing into the box.
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          this._cancelTextEditor();
        }
      });
      input.addEventListener('blur', commit);

      wrap.appendChild(input);
      input.focus();
      this._textEditor = { input, point };
    }

    _commitTextEditor() {
      const editor = this._textEditor;
      if (!editor) return;
      this._textEditor = null;
      const text = editor.input.value.trim();
      editor.input.remove();
      if (!text) return;

      const note = this._noteForDrawing();
      note.strokes.push({ tool: 'text', color: this.color, width: this.lineWidth, points: [editor.point], text });
      this._notifyNotesChanged();
      this._redraw();
    }

    _cancelTextEditor() {
      const editor = this._textEditor;
      if (!editor) return;
      this._textEditor = null;
      editor.input.remove();
    }

    // Points are normalized to the canvas's own size (0..1) so saved notes
    // stay aligned with the video no matter what size the canvas is redrawn
    // at later.
    _point(e) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    }

    _redraw(includeCurrent) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      const note = this._visibleNote();
      if (note) {
        for (const s of note.strokes) this._drawStroke(s);
      }
      if (includeCurrent && this.currentStroke) this._drawStroke(this.currentStroke);
    }

    _drawStroke(s) {
      const ctx = this.ctx;
      const pts = s.points;
      if (!pts || pts.length < 1) return;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const px = (p) => ({ x: p.x * W, y: p.y * H });

      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width * (window.devicePixelRatio || 1);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (s.tool === 'pen') {
        ctx.beginPath();
        const p0 = px(pts[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const p = px(pts[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      } else if (s.tool === 'line' || s.tool === 'arrow') {
        if (!pts[1]) return;
        const a = px(pts[0]);
        const b = px(pts[1]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (s.tool === 'arrow') this._drawArrowHead(a, b, ctx.lineWidth);
      } else if (s.tool === 'rect') {
        if (!pts[1]) return;
        const a = px(pts[0]);
        const b = px(pts[1]);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      } else if (s.tool === 'ellipse') {
        if (!pts[1]) return;
        const a = px(pts[0]);
        const b = px(pts[1]);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const rx = Math.abs(b.x - a.x) / 2;
        const ry = Math.abs(b.y - a.y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.tool === 'text') {
        if (!s.text) return;
        const p0 = px(pts[0]);
        const dpr = window.devicePixelRatio || 1;
        const fontSize = Math.max(12, s.width * 4) * dpr;
        ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textBaseline = 'top';
        // A dark outline keeps the text legible over any video background,
        // the same way broadcast telestration text usually is.
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fontSize / 8);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.strokeText(s.text, p0.x, p0.y);
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, p0.x, p0.y);
      }
    }

    _drawArrowHead(a, b, width) {
      const ctx = this.ctx;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const headLen = Math.max(10, width * 3);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(
        b.x - headLen * Math.cos(angle - Math.PI / 6),
        b.y - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        b.x - headLen * Math.cos(angle + Math.PI / 6),
        b.y - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }
  }

  global.TelestrationPlayer = TelestrationPlayer;
})(window);
