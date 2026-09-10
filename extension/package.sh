#!/usr/bin/env bash
# Produces a Chrome Web Store-ready zip of the extension.
#
# Why this exists: extension/shared and extension/web are symlinks to the
# top-level shared/ and web/ folders (so an unpacked dev load can resolve
# them without duplicating files). A Chrome Web Store upload is a single
# zip, and symlinks don't survive zipping reliably across platforms or the
# reviewer's unzipper -- so this script dereferences them into real copies
# before zipping.
#
# Usage:   ./extension/package.sh
# Output:  dist/film-room-downloader-v<version>.zip

set -euo pipefail

cd "$(dirname "$0")/.."

# Read the version out of the manifest so the zip name tracks it without a
# second source of truth.
version=$(node -e "console.log(require('./extension/manifest.json').version)")
out_dir="dist"
zip_name="film-room-downloader-v${version}.zip"
stage="$out_dir/.stage"

rm -rf "$stage"
mkdir -p "$stage"

# cp -RL dereferences symlinks: extension/shared and extension/web become
# real directory trees inside the stage, exactly what the store expects.
cp -RL extension/. "$stage/"
# package.sh is a dev tool, not part of the shipped extension.
rm -f "$stage/package.sh"

# Sanity check: no symlinks should remain in the staged copy.
if find "$stage" -type l | grep -q .; then
  echo "ERROR: symlinks remain in staged copy:" >&2
  find "$stage" -type l >&2
  exit 1
fi

mkdir -p "$out_dir"
rm -f "$out_dir/$zip_name"
( cd "$stage" && zip -r -X "../$zip_name" . >/dev/null )
rm -rf "$stage"

echo "Built $out_dir/$zip_name"
echo "Upload it at https://chrome.google.com/webstore/devconsole/"
