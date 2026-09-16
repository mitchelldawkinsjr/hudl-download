// Phase 3 gate: a marked synthetic play produces two validated MP4 angles,
// with recording paths resolved from DB source records (not preview URLs).
// Also covers: missing recording → angle 'missing'; permanent failure →
// job 'dead' + angle 'failed'; transient failure → requeue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import http from 'node:http';
import { readFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, withTransaction, leaseDueJob, closePool } from '../src/db.js';
import { processJob, requeueOrDead, type PipelineDeps } from '../src/pipeline.js';
import { HttpRecordingsAdapter, type Segment } from '../src/recordings.js';
import { probe } from '../src/ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..');
const DB = process.env.TEST_DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom_test';
process.env.DATABASE_URL = DB;
process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
process.env.RECORDING_SETTLE_MS = '0'; // don't wait in tests

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

let stubPort = 0;
let stub: http.Server;
let requestedPaths: string[] = [];
let segFile: string;
let mediaDir: string;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}: ${err.slice(0, 400)}`))));
  });
}

async function makeSegment(path: string): Promise<void> {
  // 2s, 320x240, 10fps H.264 — a "recorded segment" the worker will remux.
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path]);
}

async function migrate() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await c.query('select filename from schema_migrations');
    const applied = new Set(rows.map((r: { filename: string }) => r.filename));
    const files = ['0001_init.sql', '0002_events.sql', '0003_worker_heartbeats.sql', '0004_retention.sql'];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(REPO_ROOT, 'db/migrations', f), 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query(`insert into schema_migrations (filename) values ('${f}')`); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { await c.end(); }
}

async function resetDb() {
  for (const t of ['events', 'audit_events', 'worker_heartbeats', 'retention_settings', 'telestrations', 'media_jobs', 'play_angles', 'plays',
    'game_sources', 'source_status_snapshots', 'sources', 'mediamtx_server_settings', 'games',
    'team_members', 'teams', 'users']) {
    await query(`truncate table ${t} cascade`);
  }
}

interface Seed {
  teamId: string;
  gameId: string;
  droneSourceId: string;
  pressSourceId: string;
  playId: string;
  droneAngleId: string;
  pressAngleId: string;
  droneJobId: string;
  pressJobId: string;
}

async function seedPlay(): Promise<Seed> {
  return withTransaction(async (c) => {
    const u = await c.query(`insert into users (email, display_name, password_hash, role) values ('w@test.test','W','x','admin') returning id`);
    const tm = await c.query(`insert into teams (name, slug) values ('Home','home') returning id`);
    await c.query('insert into team_members (user_id, team_id) values ($1,$2)', [u.rows[0].id, tm.rows[0].id]);
    const drone = await c.query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active) values ($1,'drone','Drone','drone','hls',0,true) returning id`, [tm.rows[0].id]);
    const press = await c.query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active) values ($1,'pressbox','Press Box','press-box','hls',1,true) returning id`, [tm.rows[0].id]);
    const g = await c.query(`insert into games (team_id, opponent, status, started_at) values ($1,'Visitors','live', now()) returning id`, [tm.rows[0].id]);
    await c.query(`insert into game_sources (game_id, source_id, sort_order) values ($1,$2,0),($1,$3,1)`, [g.rows[0].id, drone.rows[0].id, press.rows[0].id]);
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() - 58_000);
    const play = await c.query(`insert into plays (game_id, play_number, mark_time, requested_start_time, requested_end_time) values ($1,1,now(),$2,$3) returning id`, [g.rows[0].id, start, end]);
    const da = await c.query(`insert into play_angles (play_id, source_id, status, requested_start_time, requested_end_time) values ($1,$2,'queued',$3,$4) returning id`, [play.rows[0].id, drone.rows[0].id, start, end]);
    const pa = await c.query(`insert into play_angles (play_id, source_id, status, requested_start_time, requested_end_time) values ($1,$2,'queued',$3,$4) returning id`, [play.rows[0].id, press.rows[0].id, start, end]);
    const dj = await c.query(`insert into media_jobs (type, play_angle_id, status, run_after, payload_json) values ('clip',$1,'queued',now(),$2) returning id`, [da.rows[0].id, JSON.stringify({ sourceId: drone.rows[0].id, mediamtxPath: 'drone' })]);
    const pj = await c.query(`insert into media_jobs (type, play_angle_id, status, run_after, payload_json) values ('clip',$1,'queued',now(),$2) returning id`, [pa.rows[0].id, JSON.stringify({ sourceId: press.rows[0].id, mediamtxPath: 'press-box' })]);
    return {
      teamId: tm.rows[0].id, gameId: g.rows[0].id,
      droneSourceId: drone.rows[0].id, pressSourceId: press.rows[0].id,
      playId: play.rows[0].id, droneAngleId: da.rows[0].id, pressAngleId: pa.rows[0].id,
      droneJobId: dj.rows[0].id, pressJobId: pj.rows[0].id,
    };
  });
}

function startStub(opts: { mode: 'ok' | 'missing' | 'transient' | 'bad' } = { mode: 'ok' }): Promise<void> {
  requestedPaths = [];
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      const u = new URL(req.url || '', `http://127.0.0.1:${stubPort}`);
      if (u.pathname === '/recordings/list') {
        const path = u.searchParams.get('path') || '';
        requestedPaths.push(path);
        if (opts.mode === 'missing') { res.writeHead(404); res.end(); return; }
        if (opts.mode === 'transient') { res.writeHead(500); res.end(); return; }
        const from = new Date(u.searchParams.get('from') || 0).getTime();
        const to = new Date(u.searchParams.get('to') || 0).getTime();
        // Return one segment covering the window.
        const segs: Segment[] = [{
          url: `http://127.0.0.1:${stubPort}/seg.mp4`,
          startIso: new Date(from - 1000).toISOString(),
          endIso: new Date(to + 1000).toISOString(),
        }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ segments: segs }));
        return;
      }
      if (u.pathname === '/seg.mp4') {
        if (opts.mode === 'bad') {
          // Serve non-video bytes → remux/transcode fail.
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.from('not a video file at all'));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        createReadStream(segFile).pipe(res);
        return;
      }
      res.writeHead(404); res.end();
    });
    stub.listen(0, '127.0.0.1', () => {
      stubPort = (stub.address() as { port: number }).port;
      resolve();
    });
  });
}

async function stopStub() { if (stub) await new Promise<void>((r) => stub.close(() => r())); }

function deps(): PipelineDeps {
  return {
    adapter: new HttpRecordingsAdapter(`http://127.0.0.1:${stubPort}`, 256 * 1024 * 1024),
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, mediaOutputDir: mediaDir,
  };
}

test.before(async () => {
  mediaDir = await import('node:os').then(({ tmpdir }) => join(tmpdir(), `filmroom-test-${Date.now()}`));
  mkdirSync(mediaDir, { recursive: true });
  segFile = join(mediaDir, 'seg.mp4');
  await makeSegment(segFile);
  await migrate();
  await resetDb();
});

test.after(async () => { await closePool(); });

test('Phase 3 gate: marked synthetic play → two validated MP4 angles, paths from DB', async () => {
  await startStub({ mode: 'ok' });
  try {
    await resetDb();
    const s = await seedPlay();

    // Lease and process both jobs.
    for (let i = 0; i < 2; i++) {
      const job = await leaseDueJob('test-worker', 60_000);
      assert.ok(job, `job ${i} leased`);
      await processJob(job, deps());
    }

    // Both angles ready.
    const da = await query('select * from play_angles where id = $1', [s.droneAngleId]);
    const pa = await query('select * from play_angles where id = $1', [s.pressAngleId]);
    assert.equal(da.rows[0].status, 'ready');
    assert.equal(pa.rows[0].status, 'ready');
    assert.ok(da.rows[0].checksum);
    assert.ok(pa.rows[0].checksum);
    assert.ok(da.rows[0].duration_ms && da.rows[0].duration_ms > 0);

    // MP4 files exist at the expected DB-derived paths.
    const droneMp4 = join(mediaDir, 'games', s.gameId, 'plays', s.playId, 'drone.mp4');
    const pressMp4 = join(mediaDir, 'games', s.gameId, 'plays', s.playId, 'pressbox.mp4');
    assert.ok(existsSync(droneMp4), 'drone mp4 exists');
    assert.ok(existsSync(pressMp4), 'press mp4 exists');
    assert.ok(existsSync(join(mediaDir, 'games', s.gameId, 'plays', s.playId, 'drone.manifest.json')), 'manifest exists');

    // ffprobe validates the produced clips.
    const dp = await probe(droneMp4, FFPROBE);
    assert.ok(dp.hasVideo && dp.duration > 0 && dp.width && dp.height);

    // Recording paths requested from the stub used the DB source mediamtx_path.
    assert.ok(requestedPaths.some((p) => p === `games/${s.gameId}/drone`), `drone path from DB: ${requestedPaths}`);
    assert.ok(requestedPaths.some((p) => p === `games/${s.gameId}/press-box`), `press path from DB: ${requestedPaths}`);

    // Jobs marked succeeded.
    const jobs = await query("select status from media_jobs where status='succeeded'");
    assert.equal(jobs.rows.length, 2);

    // The worker emitted a play.angle.updated event per angle (Phase 4 feed).
    const ev = await query("select type, payload_json from events where game_id = $1 and type = 'play.angle.updated'", [s.gameId]);
    assert.equal(ev.rows.length, 2, 'one event per angle');
    assert.ok(ev.rows.every((r) => {
      const p = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json;
      return p.status === 'ready';
    }));
  } finally { await stopStub(); }
});

test('missing recording → angle missing, job succeeded (not a hard failure)', async () => {
  await startStub({ mode: 'missing' });
  try {
    await resetDb();
    const s = await seedPlay();
    const job = await leaseDueJob('test-worker', 60_000);
    assert.ok(job);
    await processJob(job, deps());
    const a = await query('select status, error_code from play_angles where id = $1', [s.droneAngleId]);
    assert.equal(a.rows[0].status, 'missing');
    assert.equal(a.rows[0].error_code, 'no_recording');
    const j = await query('select status from media_jobs where id = $1', [s.droneJobId]);
    assert.equal(j.rows[0].status, 'succeeded');
  } finally { await stopStub(); }
});

test('transient failure (stub 500) → job requeued, not dead', async () => {
  await startStub({ mode: 'transient' });
  try {
    await resetDb();
    const s = await seedPlay();
    const job = await leaseDueJob('test-worker', 60_000);
    assert.ok(job);
    let err: unknown;
    try { await processJob(job, deps()); assert.fail('should have thrown'); }
    catch (e) { err = e; }
    // processJob re-throws a TransientError for the stub 500.
    const requeued = await requeueOrDead(job, err);
    assert.equal(requeued, true);
    const j = await query('select status, run_after from media_jobs where id = $1', [s.droneJobId]);
    assert.equal(j.rows[0].status, 'queued');
    assert.ok(new Date(j.rows[0].run_after).getTime() > Date.now() - 1000);
  } finally { await stopStub(); }
});

test('permanent failure (bad segment) → job dead + angle failed after exhausting attempts', async () => {
  await startStub({ mode: 'bad' });
  try {
    await resetDb();
    const s = await seedPlay();
    // Force max_attempts = 1 so the first permanent failure deads the job.
    await query('update media_jobs set max_attempts = 1 where id = $1', [s.droneJobId]);
    const job = await leaseDueJob('test-worker', 60_000);
    assert.ok(job);
    try { await processJob(job, deps()); assert.fail('should have thrown'); }
    catch { /* expected */ }
    // requeueOrDead with a non-transient error → dead.
    const alive = await requeueOrDead(job, new Error('clip validation failed: missing video stream'));
    assert.equal(alive, false);
    const j = await query('select status from media_jobs where id = $1', [s.droneJobId]);
    assert.equal(j.rows[0].status, 'dead');
    const a = await query('select status, error_code from play_angles where id = $1', [s.droneAngleId]);
    assert.equal(a.rows[0].status, 'failed');
    assert.equal(a.rows[0].error_code, 'permanent');
  } finally { await stopStub(); }
});

test('heartbeat: upserts a row per worker, reflecting status', async () => {
  await resetDb();
  const { heartbeat } = await import('../src/heartbeat.js');
  await heartbeat({ workerId: 'w1', status: 'idle' });
  let r = await query('select status from worker_heartbeats where worker_id = $1', ['w1']);
  assert.equal(r.rows[0].status, 'idle');
  await heartbeat({ workerId: 'w1', status: 'processing', lastJobId: '11111111-1111-1111-1111-111111111111' });
  r = await query('select status, last_job_id from worker_heartbeats where worker_id = $1', ['w1']);
  assert.equal(r.rows[0].status, 'processing');
  assert.equal(r.rows[0].last_job_id, '11111111-1111-1111-1111-111111111111');
  // Still a single row (upsert, not insert).
  r = await query('select count(*)::int as n from worker_heartbeats where worker_id = $1', ['w1']);
  assert.equal(r.rows[0].n, 1);
});
