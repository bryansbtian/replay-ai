# End-to-End Tests

Playwright specs live here. There are none: the browser suites run under Vitest instead,
in `tests/surfaces/` and `tests/replay/browserReplay.test.ts`, so that the Playwright
adapter and the replay engine are included in the coverage measurement.

`npm run test:e2e` therefore passes with no specs (`--pass-with-no-tests`). The harness
stays wired for a future suite that needs the Playwright runner itself, such as one using
traces or multiple browser projects.

Unit and integration tests run under Vitest in `tests/` and are excluded from this
directory.
