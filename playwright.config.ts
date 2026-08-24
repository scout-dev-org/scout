import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 3, // One per browser project — they share one database, so keep it at the project count
  use: {
    baseURL: 'http://localhost:10020',
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
    port: 10020,
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
