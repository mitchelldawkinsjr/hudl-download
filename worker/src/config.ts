// Worker configuration. Reads from the environment with sane dev defaults.
// All durations are in milliseconds unless noted.

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${v}`);
  return n;
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export const config = {
  workerId: str('WORKER_ID', `w-${process.pid}`),
  pollMs: num('WORKER_POLL_MS', 1000),
  leaseMs: num('JOB_LEASE_MS', 60_000),
  recordingSettleMs: num('RECORDING_SETTLE_MS', 2000),
  // External MediaMTX recording index/serve base (HTTP). The adapter queries
  // {base}/recordings/list?path=...&from=...&to=... and fetches segment URLs.
  mediamtxRecordingHttpBase: str('MEDIAMTX_RECORDING_HTTP_BASE', 'http://127.0.0.1:9997'),
  // Where validated angles + thumbnails are written.
  mediaOutputDir: str('MEDIA_OUTPUT_DIR', './media'),
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
  // Max segment bytes to fetch (guard). 256 MiB.
  maxSegmentBytes: num('MAX_SEGMENT_BYTES', 256 * 1024 * 1024),
  logLevel: str('LOG_LEVEL', 'info'),
};
