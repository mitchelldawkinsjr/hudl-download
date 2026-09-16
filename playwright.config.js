// Playwright config for the Film Room current-viewer regression suite.
// Serves the web app over http:// (required for the PWA/service-worker paths
// and to avoid file:// quirks) using Python's stdlib server, then runs the
// e2e specs under tests/e2e/.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    actionTimeout: 10_000,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/e2e-setup.ts',
    cwd: require('path').resolve(__dirname, 'server'),
    url: 'http://127.0.0.1:8081/api/v1/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
