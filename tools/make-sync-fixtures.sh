#!/usr/bin/env bash
# Generates synthetic test feeds for the Film Room live multi-angle buildout.
#
# Two kinds of fixtures:
#
#  1. Sync fixtures (used by the Phase 6 side-by-side drift test):
#     Two 30fps 1080p H.264/AAC clips with a millisecond clock burned in, plus a
#     flash + beep every 5 seconds. The second clip is delayed by a known offset
#     so a sync test can assert drift/correction behavior. Human QA confirms
#     flash/beep alignment and angle-switch continuity.
#
#  2. Simple color feeds (Drone + Press Box stand-ins for general/CI testing):
#     Two short, decodes-anywhere H.264/AAC color clips with distinct colors so
#     the two angles are visually distinguishable.
#
# Requires: ffmpeg on PATH (brew install ffmpeg on macOS).
#
# Usage:
#   ./scripts/make-sync-fixtures.sh [output-dir]
#   (defaults to test-assets/fixtures/)

set -euo pipefail

OUT="${1:-test-assets/fixtures}"
mkdir -p "$OUT"

FFMPEG=ffmpeg
if ! command -v "$FFMPEG" >/dev/null 2>&1; then
  echo "error: ffmpeg not found on PATH" >&2
  exit 1
fi

# --- Sync fixtures -----------------------------------------------------------
# 30fps 1080p, 60s. drawtext prints a mm:ss.mmm clock; a white flash + 1kHz beep
# every 5s. The "delayed" clip is simply a separate render; the known offset is
# applied at publish time (publish-test-feeds.sh) or by trimming in the test.
DURATION=60
FPS=30
SIZE=1920x1080

# Font for drawtext (macOS default path; fall back to a bundled one if needed).
FONT="/System/Library/Fonts/Supplemental/Courier New.ttf"
if [[ ! -f "$FONT" ]]; then
  FONT="$(find /System/Library/Fonts /Library/Fonts -name '*.ttf' 2>/dev/null | head -n1)"
fi
FONT_ARG=()
if [[ -n "${FONT:-}" && -f "$FONT" ]]; then
  FONT_ARG=( -font "$FONT" )
fi

CLOCK_EXPR="fontsize=54:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-text_w)-30:y=30:text='%{pts\:hms}'"
FLASH_EXPR="drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=fill:enable='lt(mod(t,5),0.1)'"

echo ">> sync-master  ($OUT/sync-master.mp4)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc=duration=${DURATION}:size=${SIZE}:rate=${FPS}" \
  -f lavfi -i "sine=frequency=1000:duration=${DURATION}:sample_rate=48000" \
  -vf "${FONT_ARG:+drawtext=fontfile=${FONT}:}${CLOCK_EXPR},${FLASH_EXPR}" \
  -af "volume=0:enable='gt(mod(t,5),0.1)':volume=1:enable='lt(mod(t,5),0.1)'" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 \
  -c:a aac -b:a 128k -shortest \
  "$OUT/sync-master.mp4"

echo ">> sync-delayed ($OUT/sync-delayed.mp4)"
# Same content but tinted so the two angles are visually distinct, and rendered
# separately (the known delay is applied at publish/test time, not baked in, so
# the same file can be reused with different offsets).
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc=duration=${DURATION}:size=${SIZE}:rate=${FPS}" \
  -f lavfi -i "sine=frequency=1000:duration=${DURATION}:sample_rate=48000" \
  -vf "hue=h=120,${FONT_ARG:+drawtext=fontfile=${FONT}:}${CLOCK_EXPR},${FLASH_EXPR}" \
  -af "volume=0:enable='gt(mod(t,5),0.1)':volume=1:enable='lt(mod(t,5),0.1)'" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 \
  -c:a aac -b:a 128k -shortest \
  "$OUT/sync-delayed.mp4"

# --- Simple color feeds (Drone + Press Box stand-ins) ------------------------
echo ">> drone-feed   ($OUT/drone-feed.mp4)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x1a6dff:size=1280x720:duration=10:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=10" \
  -vf "drawtext=text='DRONE':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  -pix_fmt yuv420p -c:v libx264 -c:a aac -shortest \
  "$OUT/drone-feed.mp4"

echo ">> pressbox-feed ($OUT/pressbox-feed.mp4)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0xff6a1a:size=1280x720:duration=10:rate=30" \
  -f lavfi -i "sine=frequency=330:duration=10" \
  -vf "drawtext=text='PRESS BOX':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  -pix_fmt yuv420p -c:v libx264 -c:a aac -shortest \
  "$OUT/pressbox-feed.mp4"

echo
echo "Done. Fixtures in $OUT/:"
ls -la "$OUT"
