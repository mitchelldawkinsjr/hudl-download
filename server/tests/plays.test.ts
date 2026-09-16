import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';
import pg from 'pg';

async function createGame(ctx, teamId, opponent = 'Visitors') {
  const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId, opponent }),
  });
  if (r.status !== 201) throw new Error(`create game: ${await r.text()}`);
  return (await r.json()).data;
}

test('games: start requires at least one source', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/start`, { method: 'POST' });
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
  }
});

test('plays: Mark Play is idempotent and allocates sequential numbers', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    // Create two team-scoped (reusable) sources and assign them to the game
    // via the game_sources join table.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const srcs = await pool.query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active)
      values ($1,'drone','Drone','drone','hls',0,true),
             ($1,'pressbox','Press Box','press-box','hls',1,true) returning id`, [ctx.teamId]);
    await pool.query(`insert into game_sources (game_id, source_id, sort_order) values
      ($1,$2,0),($1,$3,1)`, [g.id, srcs.rows[0].id, srcs.rows[1].id]);

    const start = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/start`, { method: 'POST' });
    if (start.status !== 200) throw new Error(`start: ${await start.text()}`);
    assert.equal((await start.json()).data.status, 'live');

    // Mark play 1 with an idempotency key.
    const key = 'mark-001';
    const m1 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({}),
    });
    if (m1.status !== 202) throw new Error(`mark1: ${await m1.text()}`);
    const p1 = (await m1.json()).data;
    assert.equal(p1.playNumber, 1);
    assert.equal(p1.status, 'processing');
    assert.equal(p1.angles.length, 2, 'one angle per active source');

    // Repeat with the SAME idempotency key → same play, no new number.
    const m1b = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({}),
    });
    assert.equal(m1b.status, 200);
    const p1b = (await m1b.json()).data;
    assert.equal(p1b.id, p1.id);
    assert.equal(p1b.playNumber, 1);

    // Mark play 2 with a different key → play number 2.
    const m2 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mark-002' },
      body: JSON.stringify({}),
    });
    assert.equal(m2.status, 202);
    assert.equal((await m2.json()).data.playNumber, 2);

    // A media job was queued for each angle.
    const jobs = await pool.query("select count(*)::int as n from media_jobs where type='clip'");
    await pool.end();
    assert.equal(jobs.rows[0].n, 4, 'one clip job per angle per play (2 angles x 2 plays)');
  } finally {
    await ctx.close();
  }
});

test('plays: Mark Play on a non-live game is rejected', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    // No start; game is draft.
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'x' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
  }
});

test('plays: PATCH optimistic concurrency rejects stale version', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // team-scoped source + game_sources assignment, then start.
    const src = await pool.query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active)
      values ($1,'drone','Drone','drone','hls',0,true) returning id`, [ctx.teamId]);
    await pool.query('insert into game_sources (game_id, source_id, sort_order) values ($1,$2,0)', [g.id, src.rows[0].id]);
    await pool.end();
    await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/start`, { method: 'POST' });
    const m = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'oc-1' },
      body: JSON.stringify({}),
    });
    const play = (await m.json()).data;

    // Stale version (wrong) → 409.
    const stale = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${play.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 999, notes: 'x' }),
    });
    assert.equal(stale.status, 409);

    // Correct version → 200, version increments.
    const ok = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${play.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: play.version, notes: 'hello' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.version, play.version + 1);
  } finally {
    await ctx.close();
  }
});

test('plays: cross-team operator cannot read another team play', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const src = await pool.query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active)
      values ($1,'drone','Drone','drone','hls',0,true) returning id`, [ctx.teamId]);
    await pool.query('insert into game_sources (game_id, source_id, sort_order) values ($1,$2,0)', [g.id, src.rows[0].id]);
    await pool.end();
    await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/start`, { method: 'POST' });
    const m = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/plays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'iso-1' },
      body: JSON.stringify({}),
    });
    const play = (await m.json()).data;

    // other-team operator → 403.
    const r = await ctx.authed('other')(`${ctx.baseUrl}/api/v1/plays/${play.id}`);
    assert.equal(r.status, 403);
  } finally {
    await ctx.close();
  }
});
