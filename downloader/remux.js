#!/usr/bin/env node
// Merges the segments the extension downloaded into a single MP4.
// Usage: node remux.js <folder-containing-concat_list.txt> [output.mp4]
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: node remux.js <folder-containing-concat_list.txt> [output.mp4]');
  process.exit(1);
}

const listPath = path.join(folder, 'concat_list.txt');
if (!fs.existsSync(listPath)) {
  console.error('concat_list.txt not found in ' + folder);
  process.exit(1);
}

const outPath = path.resolve(process.argv[3] || path.join(folder, 'output.mp4'));

console.log('Remuxing segments listed in ' + listPath + ' -> ' + outPath);
execFileSync(
  'ffmpeg',
  ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
  { stdio: 'inherit', cwd: folder }
);
console.log('Done: ' + outPath);
