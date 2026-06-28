import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1, // Serial — avoids rate limit collisions between browser projects
  use: {
    baseURL: 'http://localhost:10009',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  // E2E covers API, dashboard, demo, and widget assets.
  webServer: {
    command: 'pnpm dev:all',
    port: 10009,
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
