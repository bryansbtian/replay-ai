# Architecture

The shipped shape is described in [README.md](README.md#architecture): a pipeline where
discovery and replay are two ways of choosing the next action, both applying it through
one shared execution layer, with `replay/` structurally forbidden from importing `llm/`.
The decisions recorded below were made while building the surface layer.

## Why `ComputerSurface` Exists

A recorded workflow has to outlive the tool that recorded it. If discovery emitted steps
phrased as Playwright calls, the artifact would be a Playwright script, and every
question the project actually cares about, replaying a workflow on a different kind of
application, handing a live session to a person, swapping in an accessibility-tree or
desktop driver, would mean rewriting the recording rather than adding an implementation.

So the workflow vocabulary is fixed at the level of intent: navigate, observe, click,
fill, extract, screenshot, addressed to a `Target` that describes a control rather than
a query. Nothing in `ComputerSurface.ts`, `types.ts`, or `errors.ts` names a browser
concept, and a test asserts it.

## Why Playwright Sits Behind An Adapter

Playwright is the best available driver for a modern web application and a poor model
for everything else the system is meant to reach. Confining it to
`src/surfaces/playwright/` costs one small adapter and buys the ability to add a second
surface without touching anything above the contract. The rule is enforced twice, by a
scoped ESLint `no-restricted-imports` rule and by `tests/architecture.test.ts`, the same
double enforcement used for the `replay` to `llm` boundary, because a boundary that is
only a convention stops being a boundary.

The adapter also translates failures. Playwright errors carry a multi-line call log and
a DOM excerpt; higher layers get a typed surface error with a stable code and a one-line
reason, and the original error is preserved as `cause`.

## Why Semantic Locators Come First

The brief is explicit that legacy applications have poor markup, unstable selectors, and
no test identifiers. A single selector per control is therefore not a design that can
work, and a CSS path such as `div:nth-child(3) > button` encodes the layout of one
particular day.

A target instead carries several strategies and a stored order, defaulting to role and
accessible name, then label, placeholder, stable attribute, text, and CSS last. Semantic
strategies describe what a control is to a user, which survives redesigns and
regenerated markup. The ordering is decided once, when the target is built, and stored;
the resolver walks the stored order and never re-sorts, so resolution during replay is
the same computation it was during discovery.

Two rules keep the fallback honest. A strategy that matches several elements is recorded
as ambiguous and skipped rather than narrowed to its first match, because silently
choosing an element is how automation clicks the wrong button. And when nothing resolves,
the failure names every strategy attempted, its outcome, its match count, and its
duration, so a broken target can be repaired without reproducing the run.

## How The Boundary Extends

A second surface implements the same six methods and writes its own resolver. The target
model, the errors, the result types, and any recorded workflow stay as they are. A legacy
web surface would keep the Playwright driver and change the resolver's priorities, for
instance weighting frame-scoped and attribute strategies above role. An
accessibility-tree or desktop surface would replace the driver entirely, resolving
strategies against a platform accessibility API where role and name are the native
vocabulary and CSS has no meaning; a strategy kind with no meaning on a surface simply
never resolves, which the fallback already handles. None of that is implemented, and
nothing in the repository claims it is.

## Session Ownership

`launchPlaywrightSession` owns the browser, context, and page. `PlaywrightSurface`
receives an open page and never launches or closes anything. That split was chosen over
having the surface own its browser for two reasons: test suites can drive many cases
against one long-lived browser, and the later human handoff needs a person to take over
the very session the automation was using and give it back, which is impossible if an
automation object believes it owns the session lifetime.

## Waiting

Every wait is state-based and bounded by one of three budgets: navigation, locator, and
action. They are defined once in `src/surfaces/timeouts.ts` and overridable through the
existing configuration system, so a sluggish legacy application is a configuration
change rather than a code change. There are no fixed sleeps in the surface; the one
delay in the repository is inside the test fixture page, which reveals an element late
specifically to prove the surface waits for state rather than for a clock.

# Artifact Schema

Placeholder. Nothing is implemented, so nothing is specified here yet.

This section will eventually document:

- the typed, versioned capability artifact and the Zod schema it is parsed with
- how a step records intent, target, and expectation rather than raw coordinates
- parameterization: which values are inputs supplied at replay time instead of baked in
- versioning and compatibility rules for artifacts written by older discovery runs
- the guarantee that artifacts never contain credentials or personal data

# Determinism & Error Handling

Placeholder. What exists today is the constraint, not the mechanism: no LLM
may participate in a replay decision, enforced by an ESLint rule on `src/replay/**` and
by `tests/architecture.test.ts`.

This section will eventually document:

- what determinism means in practice here, and where it necessarily stops (the UI under
  automation is not deterministic, so the guarantee is about decisions and step order)
- locator resolution and why it is stable across runs
- waiting and settlement, instead of fixed sleeps
- the error taxonomy: retryable, terminal, and escalation-worthy, and what each carries
- the current foundation: `ReplayAiError` with a stable `code` and a preserved `cause`

# Heterogeneity & Multi-Tenant

Placeholder. Multi-tenancy is explicitly out of scope for this project, and nothing built
so far adds tenancy plumbing, a database, or queues.

This section will eventually document:

- how heterogeneous surfaces are handled behind one surface interface
- what would change to make a run tenant-scoped, and what deliberately was not built
- why per-tenant isolation was cut rather than half-built

# Escalation & Handoff

Placeholder. `src/handoff/` is empty by design.

This section will eventually document:

- what triggers escalation: policy denial, low confidence, repeated failure, unknown state
- what a paused run hands to a person, and in what form
- how control returns, and whether a human correction can be folded back into an artifact

# Safety

Placeholder for the guardrails work. What is implemented is the credential handling
part of safety, which is the part that a public repository has to get right immediately:

- `src/config/` is the only reader of `process.env`, so secrets travel one code path
- `toSafeConfig` projects config down to loggable fields and reports the API key as a
  boolean presence flag, never a value
- the logger redacts fields whose names look secret-bearing, at any nesting depth, and
  configuration errors name the offending variable without echoing its value
- `.env` is git-ignored and `.env.example` contains placeholders only
- CodeQL scans JavaScript and TypeScript on pushes, pull requests, and weekly, using
  advanced setup (a committed workflow) rather than GitHub's default setup, because the
  repository settings call for a scanning configuration that is reviewed like any other
  change. Default setup must stay disabled, since the two cannot both be active.

This section will eventually document:

- the policy engine: allowed surfaces, blocked action classes, irreversible-action checks
- what is refused outright versus what forces a handoff
- how evidence is scrubbed before it is written or committed

# Cuts

Deliberate omissions so far, with the reasoning:

- **No queues, database, or distributed services.** Runs are local and file-based.
  Capability artifacts and evidence are files on disk, which is also what makes them
  reviewable as assignment deliverables.
- **No dependency-rule framework.** The one boundary that carries architectural weight
  (`replay` must not reach `llm`) is enforced by a scoped ESLint rule plus a test, rather
  than by a general layering tool that would need more configuration than it earns.
- **No premature abstractions.** Directories that later phases will fill contain a README
  stating their responsibility and allowed dependencies, and no placeholder interfaces.
- **No `npm audit` gate in CI.** Advisories on transitive development dependencies would
  make CI fail for reasons unrelated to the change under review. Dependabot runs weekly
  instead, and `npm run audit` is available on demand.

Surface-layer cuts:

- **No coordinate targeting.** Screenshot-and-click-at-x-y is what the future Anthropic
  computer-use path may need, and it is the least stable thing a recording can hold.
  Targets are semantic; coordinates can be added as another strategy kind when there is
  a surface that actually needs them.
- **No fuzzy or model-assisted locator recovery.** A target either resolves
  deterministically or fails with a report naming every attempt. Guessing at resolution
  time would put a non-deterministic decision inside replay, which is the one thing the
  architecture forbids.
- **No full-page DOM in observations.** `observe` returns a bounded summary: url, title,
  collapsed visible text, and named controls from the accessibility snapshot. A
  serialized DOM would be written to evidence on every step, would be unreadable, and
  would capture values a user typed.
- **No `success` flag on results.** Failures throw typed errors, so a boolean that is
  always true would only invite an unchecked call site.

Cuts made in later phases will be recorded here as they happen.
