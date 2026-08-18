# surfaces

Adapters over the things being automated.

`ComputerSurface` is the contract: navigate, observe, click, fill, extract, waitFor,
screenshot, expressed in terms of a `Target` that lists locator strategies in the order
they must be attempted. Nothing in this contract, in `types.ts`, or in `errors.ts` refers
to a browser, so a workflow recorded against one surface is not written against
Playwright.

`waitFor` answers a `SurfaceCondition`: is a target visible, does it contain some text, is
some text on screen, does the location match. It waits on the state natively and reports
what it saw rather than throwing, because a state that did not arrive is an answer a
caller reports, not a broken surface. It lives here so that no caller has to poll.

Every method takes an optional per-call `timeoutMs`. Without one the surface's own
budgets apply, which is what a caller with nothing special to say should rely on.

`playwright/` holds the only concrete implementation today. It is the single place in
`src/` allowed to import Playwright, enforced by an ESLint rule and by
`tests/architecture.test.ts`. Future surfaces (legacy web, accessibility tree, desktop)
would sit beside it and reuse the target model and the errors unchanged.

Depends on: `config` (timeouts), `logging`.
