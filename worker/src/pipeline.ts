// Clip pipeline for one job. Steps (ADR 0003/0005):
//   lease → load angle/source/game → locate recordings over HTTP (using the
//   source's saved mediamtx_path) → download segments → remux (stream-copy);
//   transcode if validation fails → ffprobe validate → thumbnail → atomic
//   move to /media/games/{gameId}/plays/{playId}/{sourceKey}.{mp4,webp} +
//   manifest.json → checksum → update angle → mark job. Partial-clip when
//   the earliest media starts after the requested start.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { query, type JobRow } from './db.js';
import { probe, concatRemux, concatTranscode, thumbnail, validateClip, type ProbeResult } from './ffmpeg.js';
import { HttpRecordingsAdapter, isTransient, TransientError, type RecordingsAdapter } from './recordings.js';
import { emitAngleEvent } from './events.js';
import { config } from './config.js';
import pino from 'pino';

const log = pino({ level: config.logLevel, name: 'worker' });

export interface PipelineDeps {
  adapter: RecordingsAdapter;
  ffmpegPath?: string;
  ffprobePath?: string;
  mediaOutputDir?: string;
}

export interface JobContext {
  angleId: string;
  playId: string;
  gameId: string;
  gameUuid: string;          // the games.uuid used in MediaMTX paths
  sourceKey: string;
  mediamtxPath: string;      // saved source path, e.g. "drone"
  requestedStart: Date;
  requestedEnd: Date;
}

async function loadContext(angleId: string): Promise<JobContext> {
  const { rows } = await query(
    `select pa.id as angle_id, pa.play_id, pa.requested_start_time, pa.requested_end_time,
            p.game_id, g.id as game_uuid, s.key as source_key, s.mediamtx_path
       from play_angles pa
       join sources s on s.id = pa.source_id
       join plays p on p.id = pa.play_id
       join games g on g.id = p.game_id
      where pa.id = $1`,
    [angleId],
    'job.context'
  );
  if (!rows[0]) throw new Error(`no play_angle for job: ${angleId}`);
  const r = rows[0];
  return {
    angleId: r.angle_id, playId: r.play_id, gameId: r.game_id, gameUuid: r.game_uuid,
    sourceKey: r.source_key, mediamtxPath: r.mediamtx_path,
    requestedStart: r.requested_start_time, requestedEnd: r.requested_end_time,
  };
}

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function atomicMove(src: string, dst: string): Promise<void> {
  // rename is atomic on the same filesystem; ensure parent dir exists.
  await mkdir(join(dst, '..'), { recursive: true });
  try { await rename(src, dst); }
  catch { /* fall back to copy+unlink if cross-device */ await copyAndUnlink(src, dst); }
}

async function copyAndUnlink(src: string, dst: string): Promise<void> {
  const { createReadStream: crs, createWriteStream: cws } = await import('node:fs');
  await pipeline(crs(src), cws(dst));
  await rm(src, { force: true });
}

export async function processJob(job: JobRow, deps: PipelineDeps): Promise<void> {
  const ffmpegPath = deps.ffmpegPath ?? config.ffmpegPath;
  const ffprobePath = deps.ffprobePath ?? config.ffprobePath;
  const mediaDir = deps.mediaOutputDir ?? config.mediaOutputDir;
  const ctx = await loadContext(job.play_angle_id!);

  // Recording window uses the source's saved mediamtx_path (NOT the preview
  // URL). Path convention: games/{gameUuid}/{mediamtx_path}.
  const recPath = `games/${ctx.gameUuid}/${ctx.mediamtxPath}`;
  const window = {
    path: recPath,
    fromIso: ctx.requestedStart.toISOString(),
    toIso: ctx.requestedEnd.toISOString(),
  };

  let segs;
  try {
    segs = await deps.adapter.listSegments(window);
  } catch (err) {
    if (isTransient(err)) throw new TransientError(`listSegments: ${(err as Error).message}`);
    throw err;
  }
  if (segs.length === 0) {
    // No recording found. If we're still within the settle window, retry;
    // otherwise mark the angle missing (not a hard failure).
    const stillSettling = Date.now() < ctx.requestedEnd.getTime() + config.recordingSettleMs;
    if (stillSettling) throw new TransientError('no segments yet (still settling)');
    await markAngle(ctx.angleId, { status: 'missing', errorCode: 'no_recording', errorMessage: 'no recording segments found for the requested window' });
    await emitAngleEvent(ctx.angleId, 'play.angle.updated', { angleId: ctx.angleId, status: 'missing', errorCode: 'no_recording' });
    await finishJob(job.id, 'succeeded', null);
    log.info({ jobId: job.id, angleId: ctx.angleId }, 'angle missing: no recording');
    return;
  }

  // Download segments into a job-scoped tmp dir.
  const work = await mkdtemp(join(tmpdir(), 'filmroom-job-'));
  try {
    const segFiles: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const buf = await deps.adapter.fetchSegment(segs[i].url);
      const f = join(work, `seg-${String(i).padStart(4, '0')}.fmp4`);
      await writeFile(f, buf);
      segFiles.push(f);
    }

    const outMp4 = join(work, `${ctx.sourceKey}.mp4`);
    let probeRes: ProbeResult;
    let transcodeUsed = false;
    try {
      const { dir: remuxDir } = await concatRemux(segFiles, outMp4, ffmpegPath);
      await rm(remuxDir, { recursive: true, force: true });
      probeRes = await probe(outMp4, ffprobePath);
      const v = validateClip(probeRes);
      if (!v.ok) {
        // Remux produced an invalid clip — transcode.
        transcodeUsed = true;
        const { dir: tcDir } = await concatTranscode(segFiles, outMp4, ffmpegPath);
        await rm(tcDir, { recursive: true, force: true });
        probeRes = await probe(outMp4, ffprobePath);
        const v2 = validateClip(probeRes);
        if (!v2.ok) throw new Error(`clip validation failed after transcode: ${v2.reason}`);
      }
    } catch (err) {
      // Remux/concat can fail on incompatible codecs — try transcode once.
      if (!transcodeUsed) {
        transcodeUsed = true;
        const { dir: tcDir } = await concatTranscode(segFiles, outMp4, ffmpegPath);
        await rm(tcDir, { recursive: true, force: true });
        probeRes = await probe(outMp4, ffprobePath);
        const v = validateClip(probeRes);
        if (!v.ok) throw new Error(`clip validation failed: ${v.reason}`);
      } else {
        throw err;
      }
    }

    const thumb = join(work, `${ctx.sourceKey}.webp`);
    try { await thumbnail(outMp4, thumb, ffmpegPath, 0.4); }
    catch { /* thumbnail is best-effort; non-fatal */ }

    // Finalize paths: /media/games/{gameId}/plays/{playId}/{sourceKey}.{mp4,webp}
    const base = join(mediaDir, 'games', ctx.gameId, 'plays', ctx.playId);
    await mkdir(base, { recursive: true });
    const finalMp4 = join(base, `${ctx.sourceKey}.mp4`);
    const finalWebp = join(base, `${ctx.sourceKey}.webp`);
    await atomicMove(outMp4, finalMp4);
    try { await atomicMove(thumb, finalWebp); } catch { /* best-effort */ }

    const checksum = await sha256(finalMp4);
    const manifest = {
      gameId: ctx.gameId, playId: ctx.playId, sourceKey: ctx.sourceKey,
      clip: `${ctx.sourceKey}.mp4`, thumbnail: `${ctx.sourceKey}.webp`,
      durationMs: Math.round(probeRes.duration * 1000),
      width: probeRes.width, height: probeRes.height, fps: probeRes.fps,
      videoCodec: probeRes.videoCodec, audioCodec: probeRes.audioCodec,
      checksum, transcodeUsed,
      segments: segs.map((s) => ({ url: s.url, startIso: s.startIso, endIso: s.endIso })),
      producedAt: new Date().toISOString(),
    };
    await writeFile(join(base, `${ctx.sourceKey}.manifest.json`), JSON.stringify(manifest, null, 2), 'utf8');

    // Partial-clip detection: earliest media starts after requested start.
    const earliest = segs.map((s) => new Date(s.startIso).getTime()).reduce((a, b) => Math.min(a, b), Infinity);
    const partial = earliest > ctx.requestedStart.getTime() + 1000; // >1s late
    const latest = segs.map((s) => new Date(s.endIso).getTime()).reduce((a, b) => Math.max(a, b), -Infinity);

    await markAngle(ctx.angleId, {
      status: 'ready',
      clipUri: `games/${ctx.gameId}/plays/${ctx.playId}/${ctx.sourceKey}.mp4`,
      thumbnailUri: `games/${ctx.gameId}/plays/${ctx.playId}/${ctx.sourceKey}.webp`,
      durationMs: Math.round(probeRes.duration * 1000),
      width: probeRes.width, height: probeRes.height, fps: probeRes.fps,
      codecs: [probeRes.videoCodec, probeRes.audioCodec].filter(Boolean).join(','),
      checksum,
      actualStart: partial ? new Date(earliest) : ctx.requestedStart,
      actualEnd: new Date(latest),
    });
    await emitAngleEvent(ctx.angleId, 'play.angle.updated', {
      angleId: ctx.angleId, status: 'ready', sourceKey: ctx.sourceKey,
      clipUri: `games/${ctx.gameId}/plays/${ctx.playId}/${ctx.sourceKey}.mp4`,
      durationMs: Math.round(probeRes.duration * 1000), partial,
    });
    await finishJob(job.id, 'succeeded', null);
    log.info({ jobId: job.id, angleId: ctx.angleId, transcodeUsed, partial }, 'angle ready');
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

interface AngleUpdate {
  status: 'ready' | 'missing' | 'failed';
  clipUri?: string;
  thumbnailUri?: string;
  durationMs?: number;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  codecs?: string;
  checksum?: string;
  actualStart?: Date;
  actualEnd?: Date;
  errorCode?: string;
  errorMessage?: string;
}

async function markAngle(angleId: string, u: AngleUpdate): Promise<void> {
  await query(
    `update play_angles set
       status = $2,
       clip_uri = coalesce($3, clip_uri),
       thumbnail_uri = coalesce($4, thumbnail_uri),
       duration_ms = coalesce($5, duration_ms),
       width = coalesce($6, width),
       height = coalesce($7, height),
       fps = coalesce($8, fps),
       codecs = coalesce($9, codecs),
       checksum = coalesce($10, checksum),
       actual_start_time = coalesce($11, actual_start_time),
       actual_end_time = coalesce($12, actual_end_time),
       error_code = coalesce($13, error_code),
       error_message = coalesce($14, error_message),
       updated_at = now()
     where id = $1`,
    [angleId, u.status, u.clipUri ?? null, u.thumbnailUri ?? null, u.durationMs ?? null,
     u.width ?? null, u.height ?? null, u.fps ?? null, u.codecs ?? null, u.checksum ?? null,
     u.actualStart ?? null, u.actualEnd ?? null, u.errorCode ?? null, u.errorMessage ?? null],
    'angle.update'
  );
}

export async function finishJob(jobId: string, status: 'succeeded' | 'failed' | 'dead', lastError: string | null): Promise<void> {
  await query(
    `update media_jobs set status = $2, last_error = $3, locked_by = null, updated_at = now() where id = $1`,
    [jobId, status, lastError],
    'job.finish'
  );
}

// Requeue a job for a later retry with backoff. Returns false if dead.
export async function requeueOrDead(job: JobRow, err: unknown): Promise<boolean> {
  const transient = isTransient(err);
  const attempts = job.attempts; // already incremented at lease
  if (!transient || attempts >= job.max_attempts) {
    const code = transient ? 'max_attempts' : 'permanent';
    const msg = (err as Error).message || String(err);
    await finishJob(job.id, 'dead', `${code}: ${msg}`);
    // Mark the angle failed.
    if (job.play_angle_id) {
      await markAngle(job.play_angle_id, { status: 'failed', errorCode: code, errorMessage: msg });
      await emitAngleEvent(job.play_angle_id, 'play.angle.updated', { angleId: job.play_angle_id, status: 'failed', errorCode: code, errorMessage: msg });
    }
    log.error({ jobId: job.id, code, msg }, 'job dead');
    return false;
  }
  const backoffMs = Math.min(30_000, 1000 * 2 ** (attempts - 1)); // 1s, 2s, 4s…
  const runAfter = new Date(Date.now() + backoffMs);
  await query(
    `update media_jobs set status = 'queued', run_after = $2, last_error = $3, locked_by = null, updated_at = now() where id = $1`,
    [job.id, runAfter, (err as Error).message],
    'job.requeue'
  );
  log.warn({ jobId: job.id, attempts, backoffMs }, 'job requeued');
  return true;
}

export function makeAdapter(): RecordingsAdapter {
  return new HttpRecordingsAdapter(config.mediamtxRecordingHttpBase, config.maxSegmentBytes);
}
