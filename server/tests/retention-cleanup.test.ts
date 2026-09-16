// Retention cleanup test (Phase 7): soft-deleted plays past the derived
// window are purged (files + rows); non-deleted plays are never touched
// (AC19), even when older than the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(__dirname, '..', '..');
const DB = process.env.TEST_DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom_test';
const MEDIA_ROOT = resolvePath(REPO, 'data/media-test-retention');

function runScript(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('node', ['--import', 'tsx', join(REPO, 'scripts/retention-cleanup.ts'), ...args], {
      cwd: join(REPO, 'server'),
      env: {
        ...process.env,
        DATABASE_URL: DB,
        MEDIA_ROOT,
        PATH: process.env.PATH || '',
        NODE_PATH: join(REPO, 'server/node_modules'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`cleanup exit ${c}: ${err.slice(0, 500)}`))));
  });
}

async function migrate() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await c.query('select filename from schema_migrations');
    const applied = new Set(rows.map((r: any) => r.filename));
    const files = ['0001_init.sql', '0002_events.sql', '0003_worker_heartbeats.sql', '0004_retention.sql'];
    for (const f of files) {
      if (applied.has(f)) continue;
      const { readFileSync } = await import('node:fs');
      const sql = readFileSync(join(REPO, 'db/migrations', f), 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query(`insert into schema_migrations (filename) values ('${f}')`); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { await c.end(); }
}

test('retention: purges soft-deleted plays past the window; never live plays (AC19)', async () => {
  await migrate();
  rmSync(MEDIA_ROOT, { recursive: true, force: true });
  mkdirSync(MEDIA_ROOT, { recursive: true });
  const pool = new pg.Pool({ connectionString: DB });
  const client = await pool.connect();
  try {
    for (const t of ['events', 'audit_events', 'worker_heartbeats', 'retention_settings', 'telestrations', 'media_jobs', 'play_angles', 'plays',
      'game_sources', 'source_status_snapshots', 'sources', 'mediamtx_server_settings', 'games',
      'team_members', 'teams', 'users']) {
      await client.query(`truncate table ${t} cascade`);
    }
    const team = await client.query("insert into teams (name, slug) values ('T','t') returning id");
    const teamId = team.rows[0].id;
    const src = await client.query("insert into sources (team_id, key, display_name, mediamtx_path) values ($1,'drone','Drone','drone') returning id", [teamId]);
    const game = await client.query("insert into games (team_id, opponent, status) values ($1,'Opp','ended') returning id", [teamId]);
    const gameId = game.rows[0].id;
    await client.query("insert into game_sources (game_id, source_id, sort_order) values ($1,$2,0)", [gameId, src.rows[0].id]);

    const old = new Date(Date.now() - 40 * 86400 * 1000); // 40 days ago
    // Soft-deleted play past the window → eligible.
    const del = await client.query(
      "insert into plays (game_id, play_number, mark_time, requested_start_time, requested_end_time, status) values ($1,1,$2,$2,$2,'deleted') returning id",
      [gameId, old]
    );
    const delPlay = del.rows[0].id;
    // Ready play past the window → NOT eligible (AC19).
    const ready = await client.query(
      "insert into plays (game_id, play_number, mark_time, requested_start_time, requested_end_time, status) values ($1,2,$2,$2,$2,'ready') returning id",
      [gameId, old]
    );
    const readyPlay = ready.rows[0].id;

    const clipDel = `games/${gameId}/plays/${delPlay}/drone.mp4`;
    const clipReady = `games/${gameId}/plays/${readyPlay}/drone.mp4`;
    await client.query(
      "insert into play_angles (play_id, source_id, status, requested_start_time, requested_end_time, clip_uri) values ($1,$2,'ready',$3,$3,$4)",
      [delPlay, src.rows[0].id, old, clipDel]
    );
    await client.query(
      "insert into play_angles (play_id, source_id, status, requested_start_time, requested_end_time, clip_uri) values ($1,$2,'ready',$3,$3,$4)",
      [readyPlay, src.rows[0].id, old, clipReady]
    );
    mkdirSync(join(MEDIA_ROOT, `games/${gameId}/plays/${delPlay}`), { recursive: true });
    mkdirSync(join(MEDIA_ROOT, `games/${gameId}/plays/${readyPlay}`), { recursive: true });
    writeFileSync(join(MEDIA_ROOT, clipDel), Buffer.from('DEL'));
    writeFileSync(join(MEDIA_ROOT, clipReady), Buffer.from('READY'));
    assert.ok(existsSync(join(MEDIA_ROOT, clipDel)));

    // Dry run first: nothing deleted.
    await runScript([]);
    assert.ok(existsSync(join(MEDIA_ROOT, clipDel)), 'dry-run must not delete files');
    const stillThere = await client.query('select count(*)::int as n from plays where id = $1', [delPlay]);
    assert.equal(stillThere.rows[0].n, 1, 'dry-run must not delete rows');

    // Apply: deleted play purged, ready play untouched.
    await runScript(['--apply']);
    assert.ok(!existsSync(join(MEDIA_ROOT, clipDel)), 'deleted play clip removed');
    assert.ok(existsSync(join(MEDIA_ROOT, clipReady)), 'ready play clip retained (AC19)');
    const delGone = await client.query('select count(*)::int as n from plays where id = $1', [delPlay]);
    assert.equal(delGone.rows[0].n, 0, 'soft-deleted play row purged');
    const readyKept = await client.query('select count(*)::int as n from plays where id = $1', [readyPlay]);
    assert.equal(readyKept.rows[0].n, 1, 'ready play retained');
  } finally {
    client.release();
    await pool.end();
    rmSync(MEDIA_ROOT, { recursive: true, force: true });
  }
});
