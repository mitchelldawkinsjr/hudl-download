// E2E setup for the Sources & Settings screen (Phase 2). Runs once via the
// Playwright `webServer` and stays alive for the test run. It applies
// migrations, seeds an admin user + team, starts a mock MediaMTX Control API,
// and starts the API on :8081 serving the repo root statically (same-origin
// UI + API, avoiding cross-origin cookie/CORS for local E2E). Kept alive by
// the listening servers; never exits.
import pg from 'pg';
import http from 'node:http';
import { readFileSync } from 'node:fs';
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
process.env.LIVE_FILMROOM_ENABLED = 'false';

const MOCK_PORT = 9997;
const API_PORT = 8081;

async function migrate() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
    const sql = readFileSync(join(REPO_ROOT, 'db/migrations/0001_init.sql'), 'utf8');
    const { rows } = await c.query('select filename from schema_migrations');
    if (!rows.find((r) => r.filename === '0001_init.sql')) {
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query("insert into schema_migrations (filename) values ('0001_init.sql')");
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.end();
  }
}

async function seed() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    for (const t of ['audit_events', 'telestrations', 'media_jobs', 'play_angles', 'plays',
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
  // Mock Control API: drone → ready (ok); press-box → 404 (no_publisher).
  const srv = http.createServer((req, res) => {
    if (req.url === '/v3/paths/get/drone') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, source: { id: 'drone' } }));
    } else if (req.url === '/v3/paths/get/press-box') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'path not found' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(MOCK_PORT, '127.0.0.1', () =>
    console.log('[e2e-setup] mock MediaMTX on :' + MOCK_PORT)
  );
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
  startMockMediamtx();
  await startApi();
  // Never resolve — the webServer keeps this process alive.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error('[e2e-setup] fatal:', e);
  process.exit(1);
});
