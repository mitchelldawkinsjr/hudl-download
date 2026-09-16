// Phase 2 gate: configure Drone + Press Box via the UI, test both previews
// (one ok, one no_publisher), assign to a game, refresh without losing
// settings. Runs against the API + mock MediaMTX started by the webServer
// (tests/e2e-setup.ts), same-origin at http://127.0.0.1:8081.
const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:8081';
const SETTINGS = `${BASE}/web/settings.html`;

async function login(page) {
  await page.goto(SETTINGS);
  await page.locator('#loginEmail').fill('admin@test.test');
  await page.locator('#loginPassword').fill('admin-pass-1');
  await page.locator('#loginForm >> button[type=submit]').click();
  await expect(page.locator('#settingsMain')).toBeVisible();
}

test('Sources & Settings: configure, test, assign, and persist on refresh', async ({ page }) => {
  await login(page);

  // (a) Configure the MediaMTX server to point at the mock Control API.
  await page.locator('#privateApiBase').fill(`http://127.0.0.1:9997`);
  await page.locator('#publicPlaybackBase').fill(`http://127.0.0.1:9997`);
  await page.locator('#hlsPublicBase').fill(`http://127.0.0.1:9997`);
  await page.locator('#rtmpHost').fill('127.0.0.1');
  await page.locator('#saveServerBtn').click();
  await expect(page.locator('#serverStatus')).toContainText('Saved');

  // (b) Add Drone source.
  await page.locator('#displayName').fill('Drone');
  await page.locator('#sourceKey').fill('drone');
  await page.locator('#mediamtxPath').fill('drone');
  await page.locator('#previewProtocol').selectOption('hls');
  await page.locator('#sourceSubmitBtn').click();
  await expect(page.locator('#sourceList')).toContainText('Drone');

  // (c) Add Press Box source.
  await page.locator('#displayName').fill('Press Box');
  await page.locator('#sourceKey').fill('press-box');
  await page.locator('#mediamtxPath').fill('press-box');
  await page.locator('#previewProtocol').selectOption('hls');
  await page.locator('#sourceSortOrder').fill('1');
  await page.locator('#sourceSubmitBtn').click();
  await expect(page.locator('#sourceList')).toContainText('Press Box');

  // (d) Test Drone → ok (publisher live), preview URL is wired.
  await page.locator('#sourceList >> button[data-act="test"]').first().click();
  await expect(page.locator('#sourceDialog')).toBeVisible();
  await page.locator('#testBtn').click();
  await expect(page.locator('#testStatus')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#previewPlaceholder')).toBeHidden();
  await expect(page.locator('#previewVideo')).not.toHaveJSProperty('src', '');
  // Publishing settings populated.
  await expect(page.locator('#pubServerUrl')).toHaveValue(/rtmp:\/\//);
  await expect(page.locator('#pubStreamKey')).not.toHaveValue('');
  await page.locator('#sourceDialog >> button[type=submit]').click();

  // (e) Test Press Box → no_publisher (mock returns 404).
  await page.locator('#sourceList >> button[data-act="test"]').nth(1).click();
  await page.locator('#testBtn').click();
  await expect(page.locator('#testStatus')).toHaveAttribute('data-state', 'no_publisher');
  await page.locator('#sourceDialog >> button[type=submit]').click();

  // (f) Create a game (via same-origin fetch in the page — no game-create UI on
  // this screen, and page.request wouldn't carry the CSRF header) and assign
  // both sources in order.
  const gameId = await page.evaluate(async () => {
    const csrf = (document.cookie.match(/csrf=([^;]+)/) || [])[1] || '';
    const me = await (await fetch('/api/v1/auth/me')).json();
    const teamId = me.data.teamIds[0];
    const r = await fetch('/api/v1/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ teamId, opponent: 'Visitors' }),
    });
    return (await r.json()).data.id;
  });
  // The dropdown was populated before this game existed; refresh it.
  await page.evaluate(() => window.FilmRoomSettings.reloadGames());

  // Select the game in the assignment dropdown and check both sources.
  await page.locator('#assignGameSelect').selectOption(gameId);
  await expect(page.locator('#assignList .assign-item')).toHaveCount(2);
  await page.locator('#assignList .assign-item').first().locator('input[type=checkbox]').check();
  await page.locator('#assignList .assign-item').last().locator('input[type=checkbox]').check();
  await page.locator('#assignList .assign-item').first().locator('[data-order]').fill('0');
  await page.locator('#assignList .assign-item').last().locator('[data-order]').fill('1');
  await page.locator('#saveAssignmentBtn').click();
  await expect(page.locator('#assignStatus')).toContainText('Saved');

  // (g) Refresh-persists: reload and confirm server config + sources + assignment intact.
  await page.reload();
  await expect(page.locator('#settingsMain')).toBeVisible();
  await expect(page.locator('#privateApiBase')).toHaveValue(`http://127.0.0.1:9997`);
  await expect(page.locator('#sourceList')).toContainText('Drone');
  await expect(page.locator('#sourceList')).toContainText('Press Box');
  await page.locator('#assignGameSelect').selectOption(gameId);
  await expect(page.locator('#assignList .assign-item input[type=checkbox]').first()).toBeChecked();
  await expect(page.locator('#assignList .assign-item input[type=checkbox]').last()).toBeChecked();
});
