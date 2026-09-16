// Events endpoint: clients poll GET /games/:id/events?since=<id> to surface
// angle status changes without refresh. Verifies authz (team-scoped), the
// since cursor, and that worker-emitted events are returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';
import { query } from '../src/db/client.js';

async function createGame(ctx, teamId, opponent = 'Visitors') {
  const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId, opponent }),
  });
  if (r.status !== 201) throw new Error(`create game: ${await r.text()}`);
  return (await r.json()).data;
}

test('events: poll returns team-scoped events after the since cursor', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    // Seed two events directly (as the worker would).
    await query(`insert into events (game_id, type, play_id, angle_id, payload_json) values ($1,'play.angle.updated',null,null,$2)`,
      [g.id, JSON.stringify({ status: 'ready' })]);
    await query(`insert into events (game_id, type, play_id, angle_id, payload_json) values ($1,'play.angle.updated',null,null,$2)`,
      [g.id, JSON.stringify({ status: 'missing' })]);

    // First poll (since=0) returns both.
    const r1 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/events?since=0`);
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()).data;
    assert.equal(d1.length, 2);
    assert.equal(d1[0].payload.status, 'ready');
    assert.equal(d1[1].payload.status, 'missing');
    const lastId = d1[1].id;

    // Second poll with since=lastId returns nothing new.
    const r2 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/events?since=${lastId}`);
    assert.equal((await r2.json()).data.length, 0);

    // A new event appears on the next poll.
    await query(`insert into events (game_id, type, payload_json) values ($1,'play.angle.updated',$2)`,
      [g.id, JSON.stringify({ status: 'failed' })]);
    const r3 = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/games/${g.id}/events?since=${lastId}`);
    const d3 = (await r3.json()).data;
    assert.equal(d3.length, 1);
    assert.equal(d3[0].payload.status, 'failed');
  } finally {
    await ctx.close();
  }
});

test('events: cross-team operator cannot read another team events', async () => {
  const ctx = await setupTest();
  try {
    const g = await createGame(ctx, ctx.teamId);
    await query(`insert into events (game_id, type, payload_json) values ($1,'play.angle.updated',$2)`,
      [g.id, JSON.stringify({})]);
    const r = await ctx.authed('other')(`${ctx.baseUrl}/api/v1/games/${g.id}/events`);
    assert.equal(r.status, 403);
  } finally {
    await ctx.close();
  }
});
