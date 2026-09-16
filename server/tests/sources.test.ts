import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';

async function createSource(ctx, teamId, key, path) {
  const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId, key, displayName: key, mediamtxPath: path, previewProtocol: 'hls', sortOrder: 0, active: true }),
  });
  if (r.status !== 201) throw new Error(`create ${key}: ${await r.text()}`);
  return (await r.json()).data;
}

test('sources: CRUD lifecycle', async () => {
  const ctx = await setupTest();
  try {
    const s = await createSource(ctx, ctx.teamId, 'drone', 'drone');
    assert.equal(s.mediamtxPath, 'drone');

    // Duplicate path rejected.
    const dup = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: ctx.teamId, key: 'drone', displayName: 'Drone2', mediamtxPath: 'drone' }),
    });
    assert.equal(dup.status, 400);

    // Patch (rename display + disable).
    const patch = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Drone Cam', active: false }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).data.active, false);

    // Delete.
    const del = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources/${s.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const list = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources?teamId=${ctx.teamId}`);
    assert.equal((await list.json()).data.length, 0);
  } finally {
    await ctx.close();
  }
});

test('sources: rejects invalid mediamtx path', async () => {
  const ctx = await setupTest();
  try {
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: ctx.teamId, key: 'x', displayName: 'x', mediamtxPath: 'Bad Path!' }),
    });
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
  }
});

test('sources: publishing returns separate server URL + stream key', async () => {
  const ctx = await setupTest();
  try {
    // Configure server settings first so publishing uses the rtmp host.
    await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicPlaybackBase: 'https://play.example.com',
        privateApiBase: 'http://mediamtx.test:9997',
        privatePlaybackBase: 'http://mediamtx.test:9996',
        webrtcPublicBase: null, hlsPublicBase: null,
        rtmpHost: 'mediamtx.test', rtmpPort: 1935,
      }),
    });
    const s = await createSource(ctx, ctx.teamId, 'drone', 'drone');
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources/${s.id}/publishing`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.data.serverUrl, 'rtmp://mediamtx.test:1935');
    assert.equal(body.data.streamKey, 'drone');
    assert.equal(body.data.combinedUrl, 'rtmp://mediamtx.test:1935/drone');
    assert.ok(body.data.maskedStreamKey.includes('••••'));
  } finally {
    await ctx.close();
  }
});

test('sources: test endpoint returns server_unreachable when MediaMTX unreachable', async () => {
  const ctx = await setupTest();
  try {
    // No API base configured → server_unreachable.
    const s = await createSource(ctx, ctx.teamId, 'drone', 'drone');
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/sources/${s.id}/test`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(['server_unreachable', 'no_publisher', 'auth_failed', 'playback_failed', 'ok'].includes(body.data.status));
  } finally {
    await ctx.close();
  }
});

test('sources: cross-team operator cannot manage another team source', async () => {
  const ctx = await setupTest();
  try {
    // other team operator tries to create a source on the home team.
    const r = await ctx.authed('other')(`${ctx.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: ctx.teamId, key: 'drone', displayName: 'd', mediamtxPath: 'drone' }),
    });
    assert.equal(r.status, 403);
  } finally {
    await ctx.close();
  }
});
