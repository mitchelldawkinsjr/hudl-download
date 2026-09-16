// Phase 5 backend: media serving (auth+team, range) + telestrations CRUD
// (per play/angle/author, optimistic version).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { setupTest } from './helpers.ts';
import { query } from '../src/db/client.js';

// The API's env.MEDIA_ROOT defaults to ./data/media (relative to cwd). env
// is parsed at import time, so write the fake clip under that default rather
// than trying to override process.env after hoisted imports.
const MEDIA_ROOT = resolvePath(process.cwd(), 'data/media');

async function seedAngle(ctx): Promise<{ playId: string; angleId: string; gameId: string }> {
  // Seed in the helpers-seeded team (ctx.teamId) so the logged-in admin can access.
  const { rows: s } = await query(`insert into sources (team_id, key, display_name, mediamtx_path, preview_protocol, sort_order, active) values ($1,'drone','Drone','drone','hls',0,true) returning id`, [ctx.teamId]);
  const { rows: g } = await query(`insert into games (team_id, opponent, status, started_at) values ($1,'Visitors','live',now()) returning id`, [ctx.teamId]);
  await query(`insert into game_sources (game_id, source_id, sort_order) values ($1,$2,0)`, [g[0].id, s[0].id]);
  const start = new Date(Date.now() - 60000), end = new Date(Date.now() - 58000);
  const { rows: p } = await query(`insert into plays (game_id, play_number, mark_time, requested_start_time, requested_end_time) values ($1,1,now(),$2,$3) returning id`, [g[0].id, start, end]);
  const clipRel = `games/${g[0].id}/plays/${p[0].id}/drone.mp4`;
  const { rows: a } = await query(
    `insert into play_angles (play_id, source_id, status, requested_start_time, requested_end_time, clip_uri, thumbnail_uri, duration_ms, width, height, codecs, checksum)
     values ($1,$2,'ready',$3,$4,$5,$6,2000,320,240,'h264','abc') returning id`,
    [p[0].id, s[0].id, start, end, clipRel, `games/${g[0].id}/plays/${p[0].id}/drone.webp`]
  );
  // Write the fake clip file under MEDIA_ROOT.
  mkdirSync(join(MEDIA_ROOT, `games/${g[0].id}/plays/${p[0].id}`), { recursive: true });
  writeFileSync(join(MEDIA_ROOT, clipRel), Buffer.from('FAKEMP4'));
  return { playId: p[0].id, angleId: a[0].id, gameId: g[0].id };
}

test('media: serves a ready angle clip behind auth+team (range-aware)', async () => {
  const ctx = await setupTest();
  try {
    const { playId, angleId } = await seedAngle(ctx);
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${playId}/angles/${angleId}/clip`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');

    // Range request → 206.
    const r2 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${playId}/angles/${angleId}/clip`, {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(r2.status, 206);
    assert.ok(r2.headers.get('content-range')?.startsWith('bytes 0-3/'));
  } finally { await ctx.close(); }
});

test('media: cross-team operator cannot read another team clip', async () => {
  const ctx = await setupTest();
  try {
    const { playId, angleId } = await seedAngle(ctx);
    const r = await ctx.authed('other')(`${ctx.baseUrl}/api/v1/plays/${playId}/angles/${angleId}/clip`);
    assert.equal(r.status, 403);
  } finally { await ctx.close(); }
});

test('telestrations: create, list, patch (optimistic), delete', async () => {
  const ctx = await setupTest();
  try {
    const { playId, angleId } = await seedAngle(ctx);
    // Create.
    const c = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${playId}/telestrations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ angleId, timeMs: 1000, strokes: [{ x: 1 }] }),
    });
    assert.equal(c.status, 201);
    const t = (await c.json()).data;
    assert.equal(t.timeMs, 1000);
    assert.equal(t.version, 1);

    // List.
    const l = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/plays/${playId}/telestrations?angleId=${angleId}`);
    assert.equal((await l.json()).data.length, 1);

    // Patch with correct version → 200, version increments.
    const p = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/telestrations/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strokes: [{ x: 2 }], version: 1 }),
    });
    assert.equal(p.status, 200);
    assert.equal((await p.json()).data.version, 2);

    // Stale version → 409.
    const stale = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/telestrations/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strokes: [], version: 1 }),
    });
    assert.equal(stale.status, 409);

    // Delete.
    const d = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/telestrations/${t.id}`, { method: 'DELETE' });
    assert.equal(d.status, 200);
  } finally { await ctx.close(); }
});
