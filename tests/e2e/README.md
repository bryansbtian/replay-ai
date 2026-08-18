# End-to-End Tests

Playwright specs live here. There are none yet: the browser surface and the replay
engine arrive in later phases, so `npm run test:e2e` currently passes with no specs
(`--pass-with-no-tests`) and exists to prove the harness is wired.

Unit and integration tests run under Vitest in `tests/` and are excluded from this
directory.
