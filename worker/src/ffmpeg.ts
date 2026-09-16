// FFmpeg/ffprobe helpers. All spawns use argument arrays (never a shell) so
// paths/manifests cannot inject commands. Stream-copy (remux) first; fall
// back to transcode (H.264 yuv420p + AAC, +faststart) if validation fails.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProbeResult {
  duration: number;       // seconds
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export async function probe(path: string, ffprobePath: string): Promise<ProbeResult> {
  const { stdout, code, stderr } = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed (${code}): ${stderr.slice(0, 500)}`);
  let j: { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string }[] };
  try { j = JSON.parse(stdout); } catch { throw new Error('ffprobe returned non-JSON'); }
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const fps = v?.avg_frame_rate ? parseFps(v.avg_frame_rate) : null;
  return {
    duration: Number(j.format?.duration || 0),
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

function parseFps(s: string): number | null {
  const [n, d] = s.split('/').map(Number);
  if (!n || !d) return null;
  return n / d;
}

// Write a concat demuxer manifest listing absolute segment paths. No shell.
async function writeConcatManifest(segments: string[]): Promise<{ dir: string; manifest: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'filmroom-clip-'));
  const manifest = join(dir, 'concat.txt');
  const lines = segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(manifest, lines + '\n', 'utf8');
  return { dir, manifest };
}

export async function concatRemux(
  segments: string[], outPath: string, ffmpegPath: string
): Promise<{ dir: string }> {
  const { dir, manifest } = await writeConcatManifest(segments);
  const { code, stderr } = await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifest,
    '-c', 'copy', '-movflags', '+faststart', outPath,
  ]);
  if (code !== 0) { await rm(dir, { recursive: true, force: true }); throw new Error(`remux failed (${code}): ${stderr.slice(0, 500)}`); }
  return { dir };
}

export async function concatTranscode(
  segments: string[], outPath: string, ffmpegPath: string
): Promise<{ dir: string }> {
  const { dir, manifest } = await writeConcatManifest(segments);
  const { code, stderr } = await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifest,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', outPath,
  ]);
  if (code !== 0) { await rm(dir, { recursive: true, force: true }); throw new Error(`transcode failed (${code}): ${stderr.slice(0, 500)}`); }
  return { dir };
}

export async function thumbnail(
  inPath: string, outPath: string, ffmpegPath: string, atPct = 0.4
): Promise<void> {
  // Probe to pick a valid timestamp (avoid black frames at very start/end).
  const p = await probe(inPath, ffmpegPath.replace('ffmpeg', 'ffprobe'));
  const t = Math.max(0.1, p.duration * atPct);
  const { code, stderr } = await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(t), '-i', inPath, '-frames:v', '1', '-q:v', '4', outPath,
  ]);
  if (code !== 0) throw new Error(`thumbnail failed (${code}): ${stderr.slice(0, 500)}`);
}

// Validate a produced clip. Reject zero-duration, missing video, or unreadable.
export function validateClip(p: ProbeResult): { ok: boolean; reason?: string } {
  if (!p.hasVideo) return { ok: false, reason: 'missing video stream' };
  if (!p.duration || p.duration <= 0) return { ok: false, reason: 'zero duration' };
  if (!p.width || !p.height) return { ok: false, reason: 'missing dimensions' };
  return { ok: true };
}
