// Health route tests (Phase 7): liveness is dependency-free; readiness
// reports the DB + worker heartbeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';
import { query } from '../src/db/client.js';

test('health: /live is 200 without a session', async () => {
  const ctx = await setupTest();
  try {
    const r = await fetch(`${ctx.baseUrl}/api/v1/health/live`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'ok');
  } finally { await ctx.close(); }
});

test('health: /ready reports db ok and lists worker heartbeats', async () => {
  const ctx = await setupTest();
  try {
    // Seed a heartbeat row directly.
    await query(
      `insert into worker_heartbeats (worker_id, status, last_seen_at) values ('w-ready', 'idle', now())`,
      [], { tag: 'test.hb' }
    );
    const r = await fetch(`${ctx.baseUrl}/api/v1/health/ready`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.deps.db, 'ok');
    const w = body.workers.find((x: any) => x.id === 'w-ready');
    assert.ok(w, 'seeded worker listed');
    assert.equal(w.state, 'live');
  } finally { await ctx.close(); }
});

test('health: /ready marks a stale worker as stale/dead by age', async () => {
  const ctx = await setupTest();
  try {
    // A heartbeat 30s ago → stale (between 15s and 60s).
    await query(
      `insert into worker_heartbeats (worker_id, status, last_seen_at) values ('w-stale', 'idle', now() - interval '30 seconds')`,
      [], { tag: 'test.hb2' }
    );
    // A heartbeat 120s ago → dead.
    await query(
      `insert into worker_heartbeats (worker_id, status, last_seen_at) values ('w-dead', 'idle', now() - interval '120 seconds')`,
      [], { tag: 'test.hb3' }
    );
    const r = await fetch(`${ctx.baseUrl}/api/v1/health/ready`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const stale = body.workers.find((x: any) => x.id === 'w-stale');
    const dead = body.workers.find((x: any) => x.id === 'w-dead');
    assert.equal(stale.state, 'stale');
    assert.equal(dead.state, 'dead');
  } finally { await ctx.close(); }
});
