// Phase 6 gate: side by side plays two ready angles in sync (drift within
// target), shared controls work, the sync-offset control persists, and
// side-by-side telestration targets Drone/Press Box/Both. Uses two
// "drone"-family paths so the mock MediaMTX serves recordings for both.
const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:8081';
const REVIEW = `${BASE}/web/review.html`;

async function api(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const csrf = (document.cookie.match(/csrf=([^;]+)/) || [])[1] || '';
    const r = await fetch('/api/v1' + p, {
      method: m,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: b ? JSON.stringify(b) : undefined,
    });
    if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}: ${await r.text()}`);
    return r.status === 204 ? null : (await r.json()).data;
  }, [method, path, body]);
}

test('Side by side: sync, shared controls, sync-offset persist, telestration target', async ({ page }) => {
  await page.request.post(`${BASE}/api/v1/_test/reset`);
  await page.goto(REVIEW);
  await page.locator('#loginEmail').fill('admin@test.test');
  await page.locator('#loginPassword').fill('admin-pass-1');
  await page.locator('#loginForm >> button[type=submit]').click();
  await expect(page.locator('#reviewMain')).toBeVisible();

  // Two ready angles via drone-family paths (mock serves both).
  await api(page, 'PUT', '/settings', {
    privateApiBase: 'http://127.0.0.1:9997', publicPlaybackBase: 'http://127.0.0.1:9997',
    privatePlaybackBase: null, webrtcPublicBase: null, hlsPublicBase: 'http://127.0.0.1:9997',
    rtmpHost: '127.0.0.1', rtmpPort: 1935,
  });
  const me = await api(page, 'GET', '/auth/me', null);
  const a = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Drone', key: 'drone', mediamtxPath: 'drone', previewProtocol: 'hls', sortOrder: 0 });
  const b = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Press Box', key: 'pressbox', mediamtxPath: 'drone-2', previewProtocol: 'hls', sortOrder: 1 });
  const game = await api(page, 'POST', '/games', { teamId: me.teamIds[0], opponent: 'Visitors' });
  await api(page, 'POST', '/games/' + game.id + '/sources', { assignments: [
    { sourceId: a.id, sortOrder: 0 }, { sourceId: b.id, sortOrder: 1 },
  ]});
  await api(page, 'POST', '/games/' + game.id + '/start', null);
  const play = await api(page, 'POST', '/games/' + game.id + '/plays', { idempotencyKey: 'sbs-1' });

  // Wait for both angles ready.
  let detail = null;
  for (let i = 0; i < 60; i++) {
    detail = await api(page, 'GET', '/plays/' + play.id, null);
    if (detail.angles.every((x) => x.status === 'ready')) break;
    await page.waitForTimeout(500);
  }
  expect(detail.angles.every((x) => x.status === 'ready')).toBe(true);

  // Open review, select game + play, activate Side by Side.
  await page.reload();
  await expect(page.locator('#reviewMain')).toBeVisible();
  await page.locator('#gameSelect').selectOption(game.id);
  await page.locator('#playSelect').selectOption(play.id);
  await page.locator('.angle-tab').filter({ hasText: /Side by Side/i }).click();
  await expect(page.locator('#sbsWrap')).toBeVisible();
  await expect(page.locator('#sbsGrid .sbs-cell')).toHaveCount(2);

  // Wait for both videos ready, play, then sample drift.
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#sbsGrid video')).every((v) => v.readyState >= 2), { timeout: 15000 });
  await page.locator('#sbsPlay').click();
  await page.waitForTimeout(1500);
  await page.locator('#sbsPause').click();
  // Drift (offset 0): |v1.currentTime - v2.currentTime| within target.
  const drift = await page.evaluate(() => {
    const vs = Array.from(document.querySelectorAll('#sbsGrid video'));
    return Math.abs(vs[0].currentTime - vs[1].currentTime);
  });
  expect(drift).toBeLessThan(0.5); // generous; algorithm keeps it tight

  // Shared seek: −5s clamps to 0; both videos move together.
  await page.locator('#sbsBack5').click();
  const times = await page.evaluate(() => Array.from(document.querySelectorAll('#sbsGrid video')).map((v) => v.currentTime));
  expect(Math.abs(times[0] - times[1])).toBeLessThan(0.5);
  expect(times[0]).toBeLessThan(1);

  // Sync offset control: set 100ms, save, persists on the follower angle.
  await page.locator('#sbsOffset').fill('100');
  await page.locator('#sbsSaveOffset').click();
  await expect(page.locator('#sbsStatus')).toContainText('offset saved');
  const saved = await api(page, 'GET', '/plays/' + play.id, null);
  const follower = saved.angles.find((x) => (x.sourceKey || x.source_key) === 'pressbox');
  expect(follower.syncOffsetMs).toBe(100);

  // Side-by-side telestration: draw target "Both" → both canvases active.
  await page.locator('input[name="sbsDraw"][value="both"]').check();
  const active = await page.evaluate(() => document.querySelectorAll('#sbsGrid .sbs-canvas.active').length);
  expect(active).toBe(2);
});
