import { defineConfig } from '@playwright/test';

// End-to-end scaffolding only. Real browser specs arrive with the Playwright
// surface adapter in a later phase; `npm run test:e2e` passes with no specs today.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'on-first-retry',
  },
});
