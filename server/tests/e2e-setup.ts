// E2E setup for the Sources & Settings screen (Phase 2). Runs once via the
// Playwright `webServer` and stays alive for the test run. It applies
// migrations, seeds an admin user + team, starts a mock MediaMTX Control API,
// and starts the API on :8081 serving the repo root statically (same-origin
// UI + API, avoiding cross-origin cookie/CORS for local E2E). Kept alive by
// the listening servers; never exits.
import pg from 'pg';
import http from 'node:http';
import { readFileSync, createReadStream, mkdirSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from '@node-rs/argon2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom_test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-32chars-minimum-ok!!';
process.env.NODE_ENV = 'test';
process.env.API_BASE_PATH = '/api/v1';
process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
process.env.SERVE_STATIC_DIR = REPO_ROOT;
process.env.MEDIA_ROOT = join(REPO_ROOT, 'test-results', 'media');
process.env.LIVE_FILMROOM_ENABLED = 'false';

const MOCK_PORT = 9997;
const API_PORT = 8081;

async function migrate() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await c.query('select filename from schema_migrations');
    const applied = new Set(rows.map((r: { filename: string }) => r.filename));
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(REPO_ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(REPO_ROOT, 'db/migrations', f), 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query(`insert into schema_migrations (filename) values ($1)`, [f]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.end();
  }
}

async function seed() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    for (const t of ['events', 'audit_events', 'telestrations', 'media_jobs', 'play_angles', 'plays',
      'game_sources', 'source_status_snapshots', 'sources', 'mediamtx_server_settings', 'games',
      'team_members', 'teams', 'users']) {
      await c.query(`truncate table ${t} cascade`);
    }
    const hash = await argon2.hash('admin-pass-1');
    const u = await c.query(
      `insert into users (email, display_name, password_hash, role) values ('admin@test.test','Admin',$1,'admin') returning id`,
      [hash]
    );
    const tm = await c.query(`insert into teams (name, slug) values ('Home Team','home') returning id`);
    await c.query('insert into team_members (user_id, team_id) values ($1,$2)', [u.rows[0].id, tm.rows[0].id]);
    console.log('[e2e-setup] seeded admin@test.test / team', tm.rows[0].id);
  } finally {
    await c.end();
  }
}

function startMockMediamtx() {
  // Mock Control API + recording HTTP endpoint:
  //   /v3/paths/get/drone → ready (ok); /v3/paths/get/press-box → 404.
  //   /recordings/list?path=... → one segment for any *drone* path; 404 for
  //     press-box (no recording).
  //   /seg.mp4 → a generated 2s H.264 segment the worker remuxes.
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${MOCK_PORT}`);
    if (u.pathname.startsWith('/v3/paths/get/') && u.pathname.includes('drone')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, source: { id: 'drone' } }));
    } else if (u.pathname.startsWith('/v3/paths/get/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'path not found' }));
    } else if (u.pathname === '/recordings/list') {
      const path = u.searchParams.get('path') || '';
      if (path.includes('drone')) {
        const from = new Date(u.searchParams.get('from') || Date.now() - 60000).getTime();
        const to = new Date(u.searchParams.get('to') || Date.now()).getTime();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ segments: [{
          url: `http://127.0.0.1:${MOCK_PORT}/seg.mp4`,
          startIso: new Date(from - 1000).toISOString(),
          endIso: new Date(to + 1000).toISOString(),
        }] }));
      } else {
        res.writeHead(404); res.end();
      }
    } else if (u.pathname === '/seg.mp4') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(join(REPO_ROOT, 'test-results', 'e2e-seg.mp4')).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
  });
  srv.listen(MOCK_PORT, '127.0.0.1', () =>
    console.log('[e2e-setup] mock MediaMTX on :' + MOCK_PORT)
  );
}

function makeSegment() {
  // Generate a 2s H.264 segment once (synchronously) for the mock to serve.
  const dir = join(REPO_ROOT, 'test-results');
  mkdirSync(dir, { recursive: true });
  const seg = join(dir, 'e2e-seg.mp4');
  if (existsSync(seg)) return;
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', seg];
  const r = spawnSync('ffmpeg', args, { stdio: 'ignore' });
  if (r.status !== 0) console.error('[e2e-setup] ffmpeg segment failed exit', r.status);
}

function startWorker() {
  // Run the media worker against the mock MediaMTX so marked plays become
  // ready during the E2E run. Writes angles to a temp media dir.
  const mediaDir = join(REPO_ROOT, 'test-results', 'media');
  mkdirSync(mediaDir, { recursive: true });
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    SSRF_ALLOW_HOSTS: '127.0.0.1',
    MEDIAMTX_RECORDING_HTTP_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    MEDIA_OUTPUT_DIR: mediaDir,
    RECORDING_SETTLE_MS: '0',
    WORKER_POLL_MS: '500',
    LOG_LEVEL: 'warn',
  };
  const w = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(REPO_ROOT, 'worker'), env, stdio: 'ignore' });
  w.on('exit', (c) => console.error('[e2e-setup] worker exited', c));
}

async function startApi() {
  const { createApp } = await import('../src/app.js');
  const { closePool } = await import('../src/db/client.js');
  const app = createApp();
  await new Promise<void>((resolve) => app.listen(API_PORT, '127.0.0.1', () => {
    console.log('[e2e-setup] API on :' + API_PORT);
    resolve();
  }));
  // Keep the process alive; the pool stays open for the test duration.
  process.on('SIGTERM', async () => { await closePool(); process.exit(0); });
  process.on('SIGINT', async () => { await closePool(); process.exit(0); });
}

async function main() {
  await migrate();
  await seed();
  makeSegment();
  startMockMediamtx();
  startWorker();
  await startApi();
  // Never resolve — the webServer keeps this process alive.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error('[e2e-setup] fatal:', e);
  process.exit(1);
});
