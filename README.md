# Film Room

An offline coaching-film player: load video clips, review them like a Hudl-style
tool with slow motion, frame stepping, and rewind/fast-forward, and draw
**timestamped telestrations** — annotations tied to the exact moment you drew
them, which disappear as you move away and reappear when you scrub back.

Ships as both a zero-install **web app** and an installable **Electron desktop
app**, sharing the same player engine. Also includes a companion stream
downloader (browser extension + remux script) for saving your own accessible
game film locally, and a parser for Hudl's "Save Page As" presentation
exports.

![Timestamped telestration demo](docs/telestration-demo.gif)

*The demo above uses a synthetic color-bar test clip (see [Generating a test
clip](#generating-a-test-clip)) — draw an arrow while paused, skip forward and
it disappears, jump back to the note and it's there again.*

## Features

- **Playback controls** — play/pause, ±5s skip, previous/next frame, variable
  speed (0.1x–2x, for true slo-mo review), scrubbable seek bar.
- **Timestamped telestration** — pen, line, arrow, rectangle, and ellipse
  tools with color and stroke-width controls. Each note is tied to the video
  timestamp you drew it at: it's visible only while playback is at (or very
  near) that moment, and disappears the instant you move away — matching how
  coaches actually use freeze-frame diagrams.
  - A **Notes** strip shows every saved note as a clickable timestamp chip —
    click one to jump straight back to it.
  - **Undo** / **Clear Note** operate on whichever note is currently visible,
    leaving every other timestamp's notes untouched.
- **Saving telestrations**
  - Web app: auto-saved to the browser's local storage, keyed to that exact
    file (name + size + last-modified), so reopening the same file restores
    its notes automatically. Explicit **Save Notes** / **Load Notes** buttons
    export/import a `.json` file for backup or moving notes to another
    machine.
  - Electron app: auto-saved to a `<video-name>.telestration.json` sidecar
    file next to the video itself, loaded automatically whenever you reopen
    that video.
- **Snapshot export** — flattens the current frame + drawing into a PNG.
- **Downloader** (`extension/` + `downloader/`) — a browser extension that
  watches the current tab for HLS/DASH manifest requests and downloads the
  segments through Chrome's own download manager (using your existing logged
  -in session — the extension never sees your password), plus a Node script
  that remuxes the segments into a single MP4 with `ffmpeg -c copy`.
- **Hudl export importer** (`shared/hudl-import.js`) — parses a Chrome "Save
  Page As → Webpage, Complete" export of a Hudl presentation page (the
  `<name>.html` + `z/` folder format Hudl produces), resolving every
  camera-angle video file and any embedded coach telestration data. Verified
  against real exports; **not yet wired into the player UI** — see
  [Roadmap](#roadmap).

## How it works

The player is plain HTML5 `<video>` + a `<canvas>` overlay — no video
processing happens anywhere:

- Speed control uses `video.playbackRate`.
- Frame-stepping pauses and nudges `currentTime` by `1/fps`.
- Telestration strokes are recorded as vector points (normalized 0–1, so they
  stay aligned regardless of window size) grouped into "notes" keyed by the
  video timestamp (in ms) at the moment you started drawing. On every
  timestamp change, the canvas is cleared and redrawn with only the note
  whose timestamp is within ~120ms of the current playhead position.
- Starting a stroke automatically pauses the video, so the timestamp can't
  drift out from under you mid-drawing.

The downloader is a similarly thin layer: it doesn't touch video bytes
either. `chrome.webRequest` observes manifest URLs, `chrome.downloads`
transfers the actual segment files (through the browser's own network stack,
so your session cookies apply automatically), and `ffmpeg -c copy` just
concatenates them — no re-encoding.

## Project layout

```
shared/          Player engine + Hudl-export parser, used by both apps
  player.js        Playback + timestamped-telestration engine
  player.css        Shared UI styling
  hudl-import.js     Parses a Hudl "Save Page As" export into a play library

web/             Zero-install web app (open web/index.html)
electron/        Installable desktop app (Electron)

extension/       Browser extension: detects & downloads HLS/DASH segments
downloader/      remux.js — merges downloaded segments into one MP4

docs/            README assets (demo GIF)
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm (for the Electron app and the
  remux script)
- [ffmpeg](https://ffmpeg.org/) on your `PATH` (for the remux script, and to
  generate a synthetic test clip if you don't have real footage handy)
  - macOS: `brew install ffmpeg`
- A Chromium-based browser (Chrome, Edge, Brave, …) if you want to use the
  downloader extension

### 1. Web app (no install)

```bash
# from the repo root
python3 -m http.server 8934
```

Then open `http://localhost:8934/web/index.html`. (You can also just
double-click `web/index.html` — it works over `file://` too, since nothing in
it depends on a server — but a local server avoids any browser quirks around
local-file permissions.)

Click **Open Video Files…** and pick any local `.mp4`/`.mov`/`.webm` files.

### 2. Electron desktop app

```bash
cd electron
npm install
npm start
```

**macOS Gatekeeper note:** the first time you `npm install`, macOS may refuse
to launch the freshly-downloaded `Electron.app` with a *"contains malware"*
warning. This is a well-known false positive on npm-distributed Electron
binaries, not an actual detection — the fix is:

```bash
xattr -cr electron/node_modules/electron/dist/Electron.app
```

If macOS has already deleted the binary (it sometimes does, not just
quarantines it), delete `electron/node_modules/electron` and re-run
`npm install` inside `electron/`, then apply the `xattr` command again before
`npm start`.

### 3. Downloader extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Visit the video page you're logged into (in a tab you're legitimately
   authorized to view), start playback so the video's manifest loads, then
   click the extension icon.
4. Click **Download** next to the detected stream. Segments save under
   `Downloads/FilmRoomDownloads/<title>/`.
5. Run the remux script on that folder:

```bash
node downloader/remux.js "~/Downloads/FilmRoomDownloads/<title>"
```

This produces `output.mp4` in that same folder — open it in the Film Room
player.

### Generating a test clip

If you don't have real footage handy, this makes a 10-second synthetic
color-bar clip (the one used for the demo GIF above) that decodes anywhere:

```bash
ffmpeg -f lavfi -i "testsrc=duration=10:size=960x540:rate=30" \
       -f lavfi -i "sine=frequency=440:duration=10" \
       -pix_fmt yuv420p -c:v libx264 -c:a aac -shortest \
       sample-clip.mp4
```

## Roadmap

- Wire `shared/hudl-import.js` into the player UI (an "Import Hudl Export…"
  button, a play list with per-play camera-angle switching, and replaying
  Hudl's own embedded coach telestrations alongside your own notes).
- DASH/fragmented-MP4 (`.m4s`) segment support in the downloader — currently
  targets the more common `.ts`-segment HLS case.

## Responsible use

The downloader extension only automates what your browser already does when
you're logged in — it doesn't handle or store credentials, and it doesn't
touch anything you aren't already authorized to view in that tab. That said,
scraping/downloading video is very likely against most platforms' Terms of
Service even when you have legitimate viewing access to the content (e.g.
your own team's film) — check the ToS of whatever site you point this at, and
use it for personal, offline review of content you have the rights to, not
redistribution.

## License

MIT — see [LICENSE](LICENSE). Applies to the code in this repository only,
not to any video content you use it with.
