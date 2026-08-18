# surfaces

Adapters over the things being automated.

`ComputerSurface` is the contract: navigate, observe, click, fill, extract, screenshot,
expressed in terms of a `Target` that lists locator strategies in the order they must be
attempted. Nothing in this contract, in `types.ts`, or in `errors.ts` refers to a
browser, so a workflow recorded against one surface is not written against Playwright.

`playwright/` holds the only concrete implementation today. It is the single place in
`src/` allowed to import Playwright, enforced by an ESLint rule and by
`tests/architecture.test.ts`. Future surfaces (legacy web, accessibility tree, desktop)
would sit beside it and reuse the target model and the errors unchanged.

Depends on: `config` (timeouts), `logging`.
