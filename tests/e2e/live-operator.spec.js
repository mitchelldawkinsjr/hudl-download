// Phase 4 gate: mark a play and see it become ready without refresh; preview-
// working (card green) is clearly distinguished from recording-ready (chip
// ready). Runs against the unified webServer (API + mock MediaMTX + worker).
const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:8081';
const LIVE = `${BASE}/web/live.html`;

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

test('Live: mark play → drone ready without refresh; preview-working vs recording-ready distinguished', async ({ page }) => {
  // Clean slate (test-only reset) so this test's sources don't collide with
  // the sources-settings test's.
  await page.request.post(`${BASE}/api/v1/_test/reset`);
  // 1. Login via the live screen.
  await page.goto(LIVE);
  await page.locator('#loginEmail').fill('admin@test.test');
  await page.locator('#loginPassword').fill('admin-pass-1');
  await page.locator('#loginForm >> button[type=submit]').click();
  await expect(page.locator('#liveMain')).toBeVisible();

  // 2. Configure server + sources + game + assignment + start (via API).
  await api(page, 'PUT', '/settings', {
    privateApiBase: 'http://127.0.0.1:9997',
    publicPlaybackBase: 'http://127.0.0.1:9997',
    privatePlaybackBase: null,
    webrtcPublicBase: null,
    hlsPublicBase: 'http://127.0.0.1:9997',
    rtmpHost: '127.0.0.1', rtmpPort: 1935,
  });
  const me = await api(page, 'GET', '/auth/me', null);
  const drone = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Drone (Live)', key: 'dronelive', mediamtxPath: 'drone-live', previewProtocol: 'hls', sortOrder: 0 });
  const press = await api(page, 'POST', '/sources', { teamId: me.teamIds[0], displayName: 'Press Box (Live)', key: 'pressboxlive', mediamtxPath: 'press-box-live', previewProtocol: 'hls', sortOrder: 1 });
  const game = await api(page, 'POST', '/games', { teamId: me.teamIds[0], opponent: 'Visitors' });
  await api(page, 'POST', '/games/' + game.id + '/sources', { assignments: [
    { sourceId: drone.id, sortOrder: 0 }, { sourceId: press.id, sortOrder: 1 },
  ]});
  await api(page, 'POST', '/games/' + game.id + '/start', null);

  // 3. Reload live to pick up the new live game + sources.
  await page.reload();
  await expect(page.locator('#liveMain')).toBeVisible();
  await expect(page.locator('#gameState')).toHaveText('live');

  // 4. Preview cards: Drone working (green), Press Box offline (no signal).
  await expect(page.locator('.preview-card').first()).toHaveAttribute('data-preview', 'working', { timeout: 15000 });
  await expect(page.locator('.preview-card').nth(1)).toHaveAttribute('data-preview', 'offline');

  // 5. Mark Play.
  await expect(page.locator('#markPlayBtn')).toBeEnabled();
  await page.locator('#markPlayBtn').click();
  await expect(page.locator('#markStatus')).toContainText(/Play \d+ marked/);

  // 6. Without refresh, the Drone angle chip becomes 'ready' (worker ran)
  //    and the Press Box chip becomes 'missing' (no recording).
  await expect(page.locator('.angle-chip').filter({ hasText: /drone/i })).toHaveAttribute('data-status', 'ready', { timeout: 30000 });
  await expect(page.locator('.angle-chip').filter({ hasText: /press/i })).toHaveAttribute('data-status', 'missing', { timeout: 30000 });

  // 7. Preview-working vs recording-ready: the Drone preview card is still
  //    green (working) while its recording chip is ready.
  await expect(page.locator('.preview-card').first()).toHaveAttribute('data-preview', 'working');
});
