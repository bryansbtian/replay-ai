# replay-ai

Computer-use automation that learns a UI workflow once and then repeats it without a
model. A natural-language goal is explored by an LLM driving a real interface during
_discovery_; a successful run is frozen into a typed, versioned **capability artifact**;
that artifact is then _replayed_ deterministically, with no LLM in the decision loop.

## Current Status

**Phase 4: the deterministic replay engine.**

On top of the Phase 1 foundation (typed configuration, structured logging, a small CLI,
enforced module boundaries, and the full quality gate), the Phase 2 surface layer (the
`ComputerSurface` contract, a locator-strategy target model, and a Playwright-backed
implementation), and the Phase 3 capability artifact (a typed, versioned, validated
document with canonical serialization and a file store), the repository can now **execute
a saved capability**: validate an invocation, run the stored steps in order, verify each
checkpoint and the final success condition, collect the declared outputs, and return a
structured result.

Replay does not use an LLM. There is no Anthropic integration and no discovery loop in
this repository yet, so the artifacts that exist were authored by hand rather than
recorded. There is also no policy engine, no evidence capture, and no human handoff.
Every directory that is still empty says so in its own README, along with the
dependencies it is allowed to have.

## Architecture

The system is a pipeline with a single shared waist. Discovery and replay are two
different ways of deciding what to do next; both apply their decisions through the same
execution layer, which is what makes a discovered run reproducible.

```text
CLI / API
   |
   +---- Discovery
   |        |
   |        +---- LLM
   |
   +---- Replay

Discovery / Replay
       |
    Artifacts
       |
    Execution
       |
  +----+-----+
  |    |     |
Surface Policy Evidence
```

A few rules matter more than the rest:

1. **`replay/` must never import from `llm/` or `discovery/`.** Replay executes a saved
   capability without a model deciding anything, which is what makes it deterministic and
   cheap. It may not import Playwright either: it drives whatever `ComputerSurface` it is
   handed. The rules are enforced twice: ESLint `no-restricted-imports` scoped to
   `src/replay/**`, and tests in `tests/architecture.test.ts` that scan imports so the
   build fails even if the lint config drifts.
2. **`config/` is the only module that reads `process.env`.** Everything else receives a
   typed, readonly `AppConfig`, so secrets travel on one code path and tests configure
   the system by passing a plain object.
3. **Playwright appears only under `src/surfaces/playwright/`.** Everything else depends
   on the `ComputerSurface` contract. Enforced the same way as the first rule: a scoped
   ESLint `no-restricted-imports` rule plus a test in `tests/architecture.test.ts`.
4. **`artifacts/` depends on neither side of the pipeline.** The capability artifact is
   the contract between discovery and replay, so it may not import `llm/`, `discovery/`,
   `replay/`, or a model SDK. It reuses the surface target model and nothing else.
   Enforced the same way, and by the same test.

## Computer Surface

Everything that touches an application goes through one contract, so that a workflow is
recorded in terms of what it means to do rather than how one library happens to do it.

```ts
interface ComputerSurface {
  navigate(url: string): Promise<ActionResult>;
  observe(): Promise<Observation>;
  click(target: Target): Promise<ActionResult>;
  fill(target: Target, value: string): Promise<ActionResult>;
  extract(target: Target, options?: ExtractionOptions): Promise<ExtractionResult>;
  screenshot(): Promise<ScreenshotResult>;
}
```

| Operation    | Behaviour                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `navigate`   | Loads a location within the navigation budget. A non-OK HTTP status is a failure, not a page to observe.     |
| `observe`    | Bounded snapshot: url, title, collapsed visible text, and named controls.                                    |
| `click`      | Resolves the target, waits for it to be actionable, activates it.                                            |
| `fill`       | Resolves the target and replaces its value. Named `fill` because a replay needs replacement, not keystrokes. |
| `extract`    | Reads `text` (default), `value`, or a named `attribute` off a resolved target.                               |
| `screenshot` | Returns PNG bytes plus the context an evidence writer needs.                                                 |

Failures throw typed errors (`TargetNotFoundError`, `AmbiguousTargetError`,
`NavigationFailedError`, `ActionFailedError`, `ExtractionFailedError`,
`SurfaceUnavailableError`, `InvalidTargetError`), each carrying a stable code and the
context needed to debug it, with the original error preserved as `cause`. Results
therefore describe completed work and carry no `success` flag to ignore.

### Targets And Locator Strategy

A `Target` is a control described by every way we know to find it, in the order those
ways must be attempted:

```ts
const searchField = createTarget('Search Field', [
  { kind: 'role', role: 'textbox', name: 'Search Term' },
  { kind: 'label', text: 'Search Term' },
  { kind: 'placeholder', text: 'Enter A Search Term' },
  { kind: 'attribute', attribute: 'data-testid', value: 'query-input' },
  { kind: 'css', selector: '#query' },
]);
```

`createTarget` sorts the strategies into the default priority order and stores that
order on the target. Resolution then walks the stored order and never re-sorts, so a
recorded workflow resolves the same way on every run. Pass
`{ ordering: 'as-given' }` when an application needs a different order.

Default priority, most robust first:

```text
Role / Accessible Name
Label
Placeholder
Stable Attribute
Text
CSS
```

Semantic strategies come first because they describe what a control is to a user, which
survives a redesign; a CSS path encodes the layout of the day, which is exactly what a
legacy application changes without notice. Listing several strategies is what lets a
target survive an application whose markup carries no test identifiers.

Resolution rules, all enforced in `LocatorResolver`:

- Each strategy gets its own locator budget and waits for the element to become visible.
  There are no fixed sleeps anywhere in the surface.
- A strategy matching exactly one element wins.
- A strategy matching several elements is recorded as ambiguous and skipped, never
  narrowed to its first match. Quietly picking one is how automation clicks the wrong
  button.
- When nothing resolves, the error names every strategy attempted, its outcome, its
  match count, and how long it took.

### Session Ownership

`launchPlaywrightSession` owns the browser; `PlaywrightSurface` receives an already-open
page and never launches or closes anything.

```ts
const session = await launchPlaywrightSession();
const surface = new PlaywrightSurface({ page: session.page, logger, timeouts });
```

The split keeps surface operations testable against one long-lived browser, and it keeps
the later human handoff possible: control of a live session can be passed to a person
and taken back, because no automation object believes it owns the session lifetime.

### Not Yet Implemented

Only the Playwright surface exists. Legacy-web, accessibility-tree, and desktop surfaces
are future extensions the contract was shaped for, not code that is present today.

## Capability Artifacts

A **capability artifact** is one workflow, frozen. It records the ordered steps, the
control each step acts on, the values a caller must supply, the values the workflow
returns, and the checkpoint that proves the workflow reached the state it was recorded
to reach. It is a plain JSON document with no model, browser, or discovery vocabulary in
it, so a person can review it in a pull request, an agent can decide whether to call it,
and a later replay engine can execute it with no LLM in the decision loop.

Artifacts live in `capabilities/`, one file per capability, named `<id>.json`. The
location is `CAPABILITIES_DIR`. Committed examples live in `capabilities/examples/`; the
store ignores subdirectories, so an example is documentation and a fixture rather than
an installed capability.

### The Shape

```jsonc
{
  "schemaVersion": "1",              // The file format
  "id": "lookup-demo-customer",      // Machine identifier, also the file name
  "name": "Lookup Demo Customer",    // Human-facing, Title Case
  "description": "...",
  "version": 1,                      // The revision of this capability
  "application": { "name": "Demo Support Console", "entryPoint": "https://demo.replay-ai.test" },
  "inputs": [...],
  "outputs": [...],
  "steps": [...],
  "successCondition": { ... },
  "businessOutcomes": [...],
  "metadata": { "createdAt": "...", "updatedAt": "...", "tags": [] }
}
```

`schemaVersion` and `version` answer different questions. `schemaVersion` is the file
format, currently `"1"`, and it is what makes a future migration possible: a reader can
tell what it is holding before it tries to parse it. `version` is the revision of this
particular capability, and it increments when the workflow is re-recorded or repaired.
An unsupported `schemaVersion` fails validation with exactly that message, before any
shape checking runs.

### Steps

An ordered list, each entry a discriminated union member carrying only the fields its
action needs.

| Step         | Fields                    | Notes                                      |
| ------------ | ------------------------- | ------------------------------------------ |
| `navigate`   | `url`, `risk`             | A literal absolute URL                     |
| `click`      | `target`, `risk`          | Target is the Phase 2 model                |
| `fill`       | `target`, `value`, `risk` | Value is a literal or an input reference   |
| `extract`    | `target`, `output`        | Assigns text to a declared output          |
| `wait`       | `condition`               | State-based only; there is no sleep step   |
| `checkpoint` | `condition`               | Asserts the workflow is where it should be |

Every step has an `id` and may carry `execution` overrides (`timeoutMs`, and
`retry.maxAttempts` up to three). Replay owns the defaults; the artifact only says where
a step differs.

### Values And Parameter References

One value model, used everywhere a step needs a value:

```json
{ "source": "literal", "value": "Checking" }
{ "source": "input", "name": "customerReference" }
```

A reference is structured data, not a template string, so validation can prove it points
at an input the capability actually declares.

### Checkpoints

The same four conditions serve the capability's `successCondition`, a `wait` step, a
`checkpoint` step, and a business outcome:

```text
targetVisible        A target is present and visible
targetContainsText   A target is visible and contains given text
textVisible          Given text is visible anywhere
urlMatches           The location matches a regular expression
```

### Business Outcomes

An expected result of the business process is not a broken automation. A capability can
declare the answers it knows about, so a later run can end with a result instead of an
escalation:

```json
{
  "code": "CUSTOMER_NOT_FOUND",
  "description": "The demo console reports that no customer matches the supplied reference.",
  "condition": { "type": "textVisible", "text": "No Customer Matches That Reference" }
}
```

Detection is not implemented. Phase 3 only makes the artifact able to say it.

### Safety Metadata

Acting steps carry a `risk` of `safe`, `risky`, or `irreversible`, defaulting to `safe`.
It is a description, never a permission: an artifact grants itself nothing, and the
policy engine that will read it stays external and authoritative. The one rule enforced
today is that an irreversible step may not declare a retry.

### Validating And Loading

```ts
import {
  FileArtifactStore,
  deserializeCapabilityArtifact,
  parseCapabilityArtifact,
  serializeCapabilityArtifact,
} from './src/artifacts/index.js';

const artifact = parseCapabilityArtifact(someUnknownValue); // schema, then semantics
const restored = deserializeCapabilityArtifact(json, { source: path });
const text = serializeCapabilityArtifact(artifact); // canonical, indented, newline-terminated

const store = new FileArtifactStore({ directory: config.capabilitiesDir });
await store.save(artifact);
await store.load('lookup-demo-customer');
await store.list();
```

There is one way in. Unknown data is never treated as an artifact without passing
schema validation and then semantic validation, which checks the relationships a schema
cannot: unique step ids, input names, output names, and outcome codes; every parameter
reference pointing at a declared input; every extract step assigning a declared output;
no declared input left unread and no declared output left unwritten.

A failure throws `ArtifactValidationError` listing every problem with its location:

```text
ARTIFACT_INVALID: Capability artifact capabilities/lookup-demo-customer.json is invalid:
  steps[1].value.name: no input named "unknownMember" is declared by this capability
  outputs[0].name: output "balance" is declared but no extract step produces it
```

Serialization runs the artifact back through validation before writing, so a file that
exists is a file that parses. Output is indented, ends with a newline, and has a key
order that does not depend on how the object was built, which keeps a pull request diff
about the workflow rather than about object construction.

## Deterministic Replay

Replay is the production path. It takes a saved capability artifact, an invocation, and a
`ComputerSurface`, and runs the workflow with **no LLM in the decision loop**. There is no
import path from `src/replay/` to `src/llm/`, to `src/discovery/`, or to a model SDK, and
two tests plus an ESLint rule keep it that way. The same artifact and the same inputs
issue the same operations in the same order.

```text
Capability Artifact + Invocation Inputs + ComputerSurface
                          |
                  Validate Inputs
                          |
                 Resolve Parameters
                          |
              Execute Steps In Stored Order
                          |
                 Evaluate Checkpoints
                          |
                    Collect Outputs
                          |
            Verify Final Success Condition
                          |
                  Structured Result
```

### Running One

```ts
import { ReplayEngine } from './src/replay/index.js';
import { PlaywrightSurface, launchPlaywrightSession } from './src/surfaces/playwright/index.js';

const session = await launchPlaywrightSession();
const surface = new PlaywrightSurface({ page: session.page, logger });
const engine = new ReplayEngine({ surface, logger, timeouts: config.surfaceTimeouts });

const result = await engine.run(artifact, { memberId: '12345' });
```

`run` always returns a result. A bad invocation, a step that failed, a condition that did
not hold, and an outcome the business already knows about are all things the run has to
describe, so none of them is thrown at the caller. The public API mentions no browser
type: swapping in another surface changes the two lines that build one.

From the command line:

```bash
npm run replay -- \
  --artifact capabilities/examples/lookup-demo-member.json \
  --input memberId=12345
```

`--capability <id>` loads from `CAPABILITIES_DIR` instead of a path, `--input name=value`
repeats, and `--headed` shows the browser. Exit codes are `0` for success, `2` for a
declared business outcome, and `1` for a failure, so a script can tell "no member matches
that reference" apart from "the automation broke".

The committed example points at a demo host that does not exist. To watch a real replay,
point its `entryPoint` and its navigate step at `tests/fixtures/member-lookup.html`, which
is exactly what `tests/replay/browserReplay.test.ts` does.

### Inputs

Invocation inputs are checked against the artifact's declared inputs **before the surface
is touched**, so a caller mistake cannot leave a half-run workflow behind:

- an unknown input is **rejected**, because a key nobody declared means the caller thinks
  this capability does something it does not;
- there is **no coercion**: `12345` is not a valid `string` input, and `"12345"` is not a
  valid `number` input;
- an omitted **optional** input resolves to the empty string, which clears the field the
  `fill` step targets. Phase 3 has no default-value model, and a `fill` is the only thing
  that reads an input;
- every problem is reported at once, and no failure message ever echoes a supplied value.

A step's value is either a literal in the artifact or a reference to a declared input.
There is no template syntax, no expression evaluation, and no `eval`: a resolver that
could compute would be a decision made at replay time.

### Outputs

Outputs come back only when the capability declared them, typed as it declared them:

```json
{ "status": "success", "outputs": { "memberName": "Ada Lovelace", "savingsBalance": 5234.17 } }
```

A surface extracts text, so one narrow conversion turns it into the declared type: a
canonical numeric literal for `number`, the words true or false for `boolean`, and the
trimmed text for `string`. A screen showing `$1,024.50` **fails** rather than being
reinterpreted, because guessing a number out of a formatted string is a decision, and
repairing it is an artifact change. A declared output that no step produced is a failure
too.

### Checkpoints And The Success Condition

A workflow is not successful because every action returned without throwing. That proves
its controls were operable, not that it reached the state it was recorded to reach:

```text
Click Search  ->  Action Returned  ->  Not Enough
                                       Must Also Verify: "Member Summary" Is Visible
```

Every replay evaluates the artifact's `successCondition`, and a replay whose success
condition fails is never reported as a success. Along the way, `checkpoint` steps assert
state and `wait` steps wait for it, using the same four conditions: `targetVisible`,
`targetContainsText`, `textVisible`, `urlMatches`. All of them are answered by
`ComputerSurface.waitFor`, which waits on the state natively; replay never polls and never
sleeps.

An evaluation keeps what was expected next to what was seen, so a failure reads:

```text
REPLAY_SUCCESS_CONDITION_FAILED
  expected: Target "Member Summary Region" Is Visible
  observed: Not Visible
```

### Timeouts And Retries

A step's budget is the artifact's override, then a replay-wide override, then the surface
timeouts already in `AppConfig`. There is no fourth set of numbers. The budget is handed
to the surface so the failure is the surface's own specific error, and it is also enforced
from the outside so a wedged surface cannot make a replay hang.

Retries are deliberately small: a step repeats the identical action, with the identical
target and value, up to the `maxAttempts` the artifact declared (Phase 3 caps it at
three). No backoff, no fallback, no alternative target. A step is only repeated when it
cannot change the application, which means `extract`, `wait`, and `checkpoint` always, and
an acting step only when the artifact calls it `safe`. A declared retry on a `risky` step
is logged and not applied, because a second submit is how one request becomes two.

### Failure Context

A failure names the capability, the step, the action, what was expected, and what was
observed, and it never carries a typed value, a credential, or a raw browser exception:
`cause` is a rendered one-line summary. Invocation values are never logged, and only input
_names_ appear in the run record.

Phase 5 will formalize the wider taxonomy (success, business outcome, recoverable
condition, hard failure) and extend these types rather than replace them.

## Technology Stack

| Concern         | Choice                                                  |
| --------------- | ------------------------------------------------------- |
| Runtime         | Node.js 22+ (CI runs 24 LTS), ES modules                |
| Language        | TypeScript 5.9 in strict mode, `NodeNext` resolution    |
| Validation      | Zod                                                     |
| Model access    | Anthropic SDK (not wired up yet)                        |
| Browser control | Playwright, behind the `ComputerSurface` adapter        |
| Tests           | Vitest with v8 coverage, Playwright Test for end-to-end |
| Quality gate    | ESLint, Prettier, GitHub Actions                        |

## Prerequisites

- Node.js 22 or newer (`node --version`)
- npm 10 or newer
- Chromium for Playwright: `npx playwright install chromium`, required by the surface
  tests
- An Anthropic API key, only for the discovery commands that arrive in a later phase

## Installation

```bash
git clone <repository-url>
cd replay-ai
npm install
npx playwright install chromium
```

## Configuration

Copy the example file and fill in what you need:

```bash
cp .env.example .env
```

| Variable            | Required | Default        | Purpose                                           |
| ------------------- | -------- | -------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | No       | none           | Model access for discovery. Replay never uses it. |
| `LOG_LEVEL`         | No       | `info`         | One of `debug`, `info`, `warn`, `error`.          |
| `EVIDENCE_DIR`      | No       | `evidence`     | Where run evidence is written.                    |
| `CAPABILITIES_DIR`  | No       | `capabilities` | Where capability artifacts are read and written.  |

Surface waiting budgets, all in milliseconds and all optional:

| Variable                        | Default | Purpose                                                |
| ------------------------------- | ------- | ------------------------------------------------------ |
| `SURFACE_NAVIGATION_TIMEOUT_MS` | `15000` | Ceiling for one page load.                             |
| `SURFACE_LOCATOR_TIMEOUT_MS`    | `5000`  | Ceiling for one locator strategy. Paid per strategy.   |
| `SURFACE_ACTION_TIMEOUT_MS`     | `10000` | Ceiling for one interaction after its target resolved. |

Notes:

- Configuration is validated on startup and fails fast with a message that names the
  offending variable and never echoes its value.
- The API key is optional so that lint, tests, builds, and replay all run without
  credentials. Commands that need it fail with an explicit message when it is absent.
- `.env` is git-ignored. Only `.env.example` is committed, and it holds placeholders.
- Relative paths resolve against the working directory.

Verify a local setup:

```bash
npx tsx src/cli/main.ts config
```

This prints one structured log record with the resolved configuration. The API key is
reported as present or absent and never printed.

## Development Commands

| Command                 | What It Does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `npm run dev`           | Runs the CLI from source in watch mode, loading `.env` if present |
| `npm run replay`        | Replays a saved capability artifact, see Deterministic Replay     |
| `npm run build`         | Compiles `src/` to `dist/` with type declarations                 |
| `npm run lint`          | ESLint, warnings treated as failures                              |
| `npm run lint:fix`      | ESLint with autofix                                               |
| `npm run format`        | Prettier, writes changes                                          |
| `npm run format:check`  | Prettier, verification only (used by CI)                          |
| `npm run typecheck`     | `tsc --noEmit` over sources, tests, and configs                   |
| `npm run test`          | Vitest, single run                                                |
| `npm run test:watch`    | Vitest in watch mode                                              |
| `npm run test:coverage` | Vitest with coverage and thresholds                               |
| `npm run test:e2e`      | Playwright end-to-end suite                                       |
| `npm run audit`         | `npm audit --audit-level=high`                                    |

## Testing

```bash
npm run test
npm run test:coverage
```

Unit and integration tests live in `tests/` and run under Vitest. Coverage is measured
over `src/` with a global threshold of 70 percent on lines, statements, functions, and
branches; CI fails below it.

The surface suites drive a real Chromium against a local HTML fixture
(`tests/fixtures/surface.html`), so they need the browser installed:

```bash
npx playwright install chromium
npm run test -- tests/surfaces
```

They run under Vitest rather than the Playwright runner so that the adapter is included
in the coverage measurement. Nothing about them reaches the network: the fixture is a
file on disk.

| Suite                                      | Covers                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| `tests/surfaces/target.test.ts`            | Strategy priority ordering, stability, and invalid targets |
| `tests/surfaces/locatorResolver.test.ts`   | Every strategy, precedence, fallback, ambiguity, budgets   |
| `tests/surfaces/playwrightSurface.test.ts` | Each surface operation and each failure mode               |
| `tests/surfaces/contract.test.ts`          | A whole workflow written against `ComputerSurface` alone   |
| `tests/replay/browserReplay.test.ts`       | A committed artifact replayed against a real browser       |
| `tests/architecture.test.ts`               | Replay, Playwright, and artifact dependency boundaries     |

`browserReplay.test.ts` is the Phase 4 proof: it loads
`capabilities/examples/lookup-demo-member.json` through the real validator, points it at
`tests/fixtures/member-lookup.html`, and runs it through `ReplayEngine`, `StepExecutor`,
`ComputerSurface`, and `PlaywrightSurface` to a successful set of outputs. It covers a
parameter change, a declared business outcome, an output the declared type cannot hold,
a failing checkpoint, and a failing success condition. It calls no model and reaches no
network.

The replay suites that are about the engine rather than a browser run in milliseconds
against a scripted surface:

```bash
npm run test -- tests/replay
```

| Suite                          | Covers                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| `tests/replay/inputs.test.ts`  | Input validation and parameter resolution                   |
| `tests/replay/engine.test.ts`  | Ordering, checkpoints, success condition, retries, budgets  |
| `tests/replay/outputs.test.ts` | Output typing, conversion refusals, and the output contract |

End-to-end tests live in `tests/e2e/` and run under Playwright. There are no specs: the
browser suites run under Vitest so the adapter and the engine are measured by coverage, so
`npm run test:e2e` passes with no tests.

The artifact suites need no browser and run in milliseconds:

```bash
npm run test -- tests/artifacts
```

| Suite                                   | Covers                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `tests/artifacts/schema.test.ts`        | Every step, checkpoint, reference, and rejection case   |
| `tests/artifacts/serialization.test.ts` | Round trip, canonical output, and the committed example |
| `tests/artifacts/store.test.ts`         | Save, load, list, malformed files, and path traversal   |

Filesystem cases run in temporary directories, so the suite never writes into the
repository's own `capabilities/` directory.

Earlier suites cover configuration loading and validation, secret redaction in both the
config projection and the logger, and the CLI command surface and its exit codes.

## Repository Structure

```text
.github/
  workflows/ci.yml      Lint, format, typecheck, coverage, build
  workflows/codeql.yml  CodeQL scanning on push, pull request, and weekly
  dependabot.yml        Weekly npm and GitHub Actions updates
  SECURITY.md           How to report a vulnerability privately
src/
  artifacts/            The capability artifact: schema, validation, storage
    artifact.ts         The capability envelope, schema version, inputs, outputs
    steps.ts            Values, targets, checkpoints, and the step union
    identifiers.ts      Identifier rules shared by the schema and the store
    validation.ts       parseCapabilityArtifact, the single entry point
    semantics.ts        Cross-field rules a schema cannot express
    serialization.ts    Canonical JSON out, validated JSON in
    store.ts            FileArtifactStore: artifacts as files in a directory
    errors.ts           Typed failures, and the boundary where Zod issues stop
  cli/                  Entry point and command surface
    replay.ts           The replay command, and the one place a surface is chosen
  config/               The only reader of process.env, Zod-validated
  discovery/            LLM-driven exploration loop (Phase 5)
  evidence/             Structured run evidence capture (Phase 5)
  execution/            Action vocabulary and executor, the shared waist (Phase 5)
  handoff/              Human handoff (Phase 5)
  llm/                  Provider-agnostic model boundary
    anthropic/          Anthropic implementation (Phase 3)
  logging/              Structured JSON logger with redaction
  policy/               Safety guardrails (Phase 5)
  replay/               Deterministic artifact execution, never imports llm/
    ReplayEngine.ts     Validate, execute in order, verify, collect, return a result
    StepExecutor.ts     One step against the surface, with bounded attempts
    CheckpointEvaluator.ts  Conditions, keeping expected next to observed
    InputValidator.ts   Invocation inputs against the declared inputs
    ParameterResolver.ts    Literal or declared input, and nothing else
    OutputCollector.ts  Extracted text into the declared output types
    deadlines.ts        The budget hierarchy and the outer bound
    ReplayResult.ts     Success, business outcome, failure
  surfaces/             The ComputerSurface contract and its implementations
    ComputerSurface.ts  The contract: navigate, observe, click, fill, extract, screenshot
    types.ts            Targets, locator strategies, observations, results
    target.ts           createTarget and the default strategy priority
    errors.ts           Surface error types with stable codes
    timeouts.ts         The three waiting budgets and their defaults
    timing.ts           Monotonic duration measurement
    playwright/         The only place in src/ allowed to import Playwright
      PlaywrightSurface.ts  The adapter
      LocatorResolver.ts    Target model to Playwright locators
      observation.ts        The bounded page snapshot
      session.ts            Browser lifecycle, owned outside the surface
  errors.ts             Shared error base with stable error codes
tests/                  Vitest suites
  artifacts/            Schema, serialization, and artifact store suites
  fixtures/             Local HTML the surface and replay suites drive
  replay/               Input, engine, output, and real-browser replay suites
  surfaces/             Surface, resolver, target, and contract suites
  e2e/                  Playwright specs
capabilities/           Capability artifacts, one JSON file per capability
  examples/             Committed example artifacts (deliverable)
evidence/               Committed example run evidence (deliverable)
```

`capabilities/` and `evidence/` are deliberately not git-ignored: example artifacts and
run evidence are project deliverables.

## Roadmap

| Phase | Scope                                                                | Status  |
| ----- | -------------------------------------------------------------------- | ------- |
| 1     | Repository foundation: config, logging, boundaries, quality gate, CI | Done    |
| 2     | Computer surface abstraction and the Playwright surface              | Done    |
| 3     | Capability artifact schema, validation, serialization, and storage   | Done    |
| 4     | Deterministic replay engine, replay CLI, real-browser replay proof   | Done    |
| 5     | Anthropic integration, discovery loop, evidence, error taxonomy      | Next    |
| 6     | Policy guardrails, escalation, human handoff                         | Planned |

Exact commands for running discovery will be added under **Development Commands** as that
phase lands.

## Design Notes

See [REPORT.md](REPORT.md) for the architecture write-up, artifact schema, determinism
and error handling, escalation, safety, and the scope cuts that were made.
