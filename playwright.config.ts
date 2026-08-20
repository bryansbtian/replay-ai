import { defineConfig } from '@playwright/test';

/**
 * The end-to-end runner.
 *
 * These specs do not drive a page: they spawn the real CLI and assert on what it printed,
 * what it wrote to disk, and the exit code it returned. Playwright is here for the runner
 * and for the fixture web server, not for its browser fixtures, which is why no `use`
 * browser options are set.
 *
 * The engine-level browser suites stay under Vitest, in `tests/surfaces/` and the
 * `browser*.test.ts` files, so that the Playwright adapter and the replay engine are
 * included in the coverage measurement.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // A case here starts a browser through the CLI and may run a whole discovery loop.
  timeout: 120_000,
  reporter: [['list']],
  // The CLI runs one browser per invocation; running specs in parallel on a laptop makes
  // the suite slower rather than faster and the timings much harder to read.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env['CI'] !== undefined,
  webServer: {
    command: 'npm run serve:fixtures',
    url: 'http://127.0.0.1:3100/member-lookup.html',
    reuseExistingServer: process.env['CI'] === undefined,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
