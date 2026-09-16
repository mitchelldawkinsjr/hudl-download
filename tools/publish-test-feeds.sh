#!/usr/bin/env bash
# Publish synthetic RTMP feeds to the (external or dev) MediaMTX for E2E/sync
# testing. Reads each source's publishing settings from the Film Room API
# (GET /api/v1/sources/:id/publishing) rather than hardcoding stream keys, so
# it works against whatever sources the admin configured (Drone, Press Box…).
#
# Usage:
#   ./tools/publish-test-feeds.sh <api-base> <admin-email> <admin-password> <source-id> [<source-id>...]
#   ./tools/publish-test-feeds.sh http://127.0.0.1:8081 admin@test.test admin-pass-1 <drone-uuid> <press-uuid>
#
# Each source is published in a loop (restarts on exit) using a testsrc feed so
# the MediaMTX path has a live publisher for preview + recording. Requires
# ffmpeg + jq + curl.
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <api-base> <email> <password> <source-id> [<source-id>...]" >&2
  exit 2
fi

API="$1"; EMAIL="$2"; PASS="$3"; shift 3
SRC_IDS=("$@")

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
command -v jq    >/dev/null || { echo "jq not found" >&2; exit 1; }
command -v curl  >/dev/null || { echo "curl not found" >&2; exit 1; }

# Log in and capture session + csrf cookies.
COOKIE_JAR="$(mktemp)"
CSRF="$(curl -s -c "$COOKIE_JAR" "$API/api/v1/auth/csrf" | jq -r '.data.token // empty')"
if [[ -z "$CSRF" ]]; then echo "no csrf token from $API" >&2; exit 1; fi
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H "content-type: application/json" \
  -H "x-csrf-token: $CSRF" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login" -o /dev/null

publish_one() {
  local sid="$1"
  local pub
  pub="$(curl -s -b "$COOKIE_JAR" "$API/api/v1/sources/$sid/publishing")"
  local server key combined
  server="$(echo "$pub" | jq -r '.data.rtmpServerUrl // empty')"
  key="$(echo "$pub" | jq -r '.data.streamKey // empty')"
  combined="$(echo "$pub" | jq -r '.data.combinedUrl // empty')"
  if [[ -z "$server" || -z "$key" ]]; then
    echo "[$sid] no publishing settings (is MediaMTX server configured?)" >&2
    return
  fi
  echo "[$sid] publishing to $combined"
  while true; do
    # testsrc gives a synthetic clock + color bars; loop until killed.
    ffmpeg -hide_banner -loglevel error -re -stream_loop -1 \
      -f lavfi -i "testsrc=size=1280x720:rate=30" \
      -f lavfi -i "sine=frequency=440:sample_rate=44100" \
      -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 60 \
      -c:a aac -b:a 128k \
      -f flv "$combined" || { echo "[$sid] publisher exited, restarting…" >&2; sleep 1; }
  done
}

for sid in "${SRC_IDS[@]}"; do
  publish_one "$sid" &
done

echo "publishing ${#SRC_IDS[@]} feed(s); Ctrl-C to stop"
wait
