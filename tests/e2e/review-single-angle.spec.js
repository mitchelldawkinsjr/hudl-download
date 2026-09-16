// Phase 5 gate: single-angle review of both sources (Drone ready, Press Box
// missing) + angle-switch continuity + missing-angle UX. Runs against the
// unified webServer (API + mock MediaMTX + worker).
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

test('Review: single-angle of both sources, continuity on switch, missing-angle UX', async ({ page }) => {
  await page.request.post(`${BASE}/api/v1/_test/reset`);
  // Login via the review screen.
  await page.goto(REVIEW);
  await page.locator('#loginEmail').fill('admin@test.test');
  await page.locator('#loginPassword').fill('admin-pass-1');
  await page.locator('#loginForm >> button[type=submit]').click();
  await expect(page.locator('#reviewMain')).toBeVisible();

  // Set up sources + game + start + mark a play (via API).
  await api(page, 'PUT', '/settings', {
    privateApiBase: 'http://127.0.0.1:9997', publicPlaybackBase: 'http://127.0.0.1:9997',
    privatePlaybackBase: null, webrtcPublicBase: null, hlsPublicBase: 'http://127.0.0.1:9997',
    rtmpHost: '127.0.0.1', rtmpPort: 1935,
  });
  const me = await api(page, 'GET', '/auth/me', null);
  const drone = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Drone', key: 'drone', mediamtxPath: 'drone', previewProtocol: 'hls', sortOrder: 0 });
  const press = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Press Box', key: 'pressbox', mediamtxPath: 'press-box', previewProtocol: 'hls', sortOrder: 1 });
  const game = await api(page, 'POST', '/games', { teamId: me.teamIds[0], opponent: 'Visitors' });
  await api(page, 'POST', '/games/' + game.id + '/sources', { assignments: [
    { sourceId: drone.id, sortOrder: 0 }, { sourceId: press.id, sortOrder: 1 },
  ]});
  await api(page, 'POST', '/games/' + game.id + '/start', null);
  const play = await api(page, 'POST', '/games/' + game.id + '/plays', { idempotencyKey: 'review-1' });

  // Wait for the worker: Drone angle ready, Press Box missing.
  let detail = null;
  for (let i = 0; i < 60; i++) {
    detail = await api(page, 'GET', '/plays/' + play.id, null);
    const droneA = detail.angles.find((a) => (a.sourceKey || a.source_key) === 'drone');
    const pressA = detail.angles.find((a) => (a.sourceKey || a.source_key) === 'pressbox');
    if (droneA?.status === 'ready' && pressA?.status === 'missing') break;
    await page.waitForTimeout(500);
  }
  const droneAngle = detail.angles.find((a) => (a.sourceKey || a.source_key) === 'drone');
  const pressAngle = detail.angles.find((a) => (a.sourceKey || a.source_key) === 'pressbox');
  expect(droneAngle.status).toBe('ready');
  expect(pressAngle.status).toBe('missing');

  // Select the game + play in the review UI (reload to pick up the new game).
  await page.reload();
  await expect(page.locator('#reviewMain')).toBeVisible();
  await page.locator('#gameSelect').selectOption(game.id);
  await page.locator('#playSelect').selectOption(play.id);
  await expect(page.locator('.angle-tab').first()).toBeVisible();

  // Drone tab: clip loads (ready).
  await page.locator('.angle-tab').filter({ hasText: /drone/i }).click();
  await expect(page.locator('#video')).toBeVisible();
  await expect(page.locator('#placeholder')).toBeHidden();
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2, { timeout: 15000 });

  // Seek to 1s, then switch to Press Box (missing-angle UX).
  await page.evaluate(() => { const v = document.getElementById('video'); v.currentTime = 1; });
  await page.locator('.angle-tab').filter({ hasText: /press/i }).click();
  await expect(page.locator('#placeholder')).toBeVisible();
  await expect(page.locator('#placeholder')).toHaveAttribute('data-status', 'missing');
  await expect(page.locator('#video')).toBeHidden();

  // Switch back to Drone — continuity: logical time preserved (~1s).
  await page.locator('.angle-tab').filter({ hasText: /drone/i }).click();
  await expect(page.locator('#video')).toBeVisible();
  await page.waitForFunction(
    () => Math.abs(document.getElementById('video').currentTime - 1) < 0.5,
    { timeout: 10000 }
  );
});
