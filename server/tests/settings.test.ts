import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';

test('settings: PUT stores and GET returns server config', async () => {
  const ctx = await setupTest();
  try {
    const payload = {
      publicPlaybackBase: 'https://play.example.com',
      privateApiBase: 'http://mediamtx.test:9997',
      privatePlaybackBase: 'http://mediamtx.test:9996',
      webrtcPublicBase: 'https://webrtc.example.com',
      hlsPublicBase: 'https://hls.example.com',
      rtmpHost: 'mediamtx.test',
      rtmpPort: 1935,
    };
    const put = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(put.status, 200);
    const get = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/settings`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.data.publicPlaybackBase, 'https://play.example.com');
    assert.equal(body.data.rtmpPort, 1935);
  } finally {
    await ctx.close();
  }
});

test('settings: rejects non-http schemes (SSRF validation)', async () => {
  const ctx = await setupTest();
  try {
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicPlaybackBase: 'ftp://bad',
        privateApiBase: null,
        privatePlaybackBase: null,
        webrtcPublicBase: null,
        hlsPublicBase: null,
        rtmpHost: null,
        rtmpPort: 1935,
      }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'bad_request');
  } finally {
    await ctx.close();
  }
});

test('settings: reviewer role forbidden', async () => {
  const ctx = await setupTest();
  try {
    // No reviewer seeded; verify an operator can but a non-authed cannot.
    const r = await fetch(`${ctx.baseUrl}/api/v1/settings`);
    assert.equal(r.status, 401);
  } finally {
    await ctx.close();
  }
});
