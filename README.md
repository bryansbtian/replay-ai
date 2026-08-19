# replay-ai

Computer-use automation that learns a UI workflow once and then repeats it without a
model. A natural-language goal is explored by an LLM driving a real interface during
_discovery_; a successful run is frozen into a typed, versioned **capability artifact**;
that artifact is then _replayed_ deterministically, with no LLM in the decision loop.

## Current Status

**Phase 7: LLM-driven workflow discovery.**

On top of the Phase 1 foundation (typed configuration, structured logging, a small CLI,
enforced module boundaries, and the full quality gate), the Phase 2 surface layer (the
`ComputerSurface` contract, a locator-strategy target model, and a Playwright-backed
implementation), and the Phase 3 capability artifact (a typed, versioned, validated
document with canonical serialization and a file store), the repository can now **execute
a saved capability**: validate an invocation, run the stored steps in order, verify each
checkpoint and the final success condition, collect the declared outputs, and return a
structured result.

Phase 5 makes that result production-grade for everything that is not the happy path. A
run now separates a **business outcome** (a known application answer) from a
**recoverable condition** (a state the capability recognizes and knows how to clear) from
a **hard failure** (a state replay will not push past), each with a stable machine-readable
code and enough context to debug it. No browser exception ever reaches a caller.

Phase 6 adds the two things a run needs before anyone would let it near a real
application. Every action is evaluated against an **external policy** before it executes,
so an artifact can describe what it does but never grant itself permission to do it. And
every run writes **sanitized evidence** to disk: a manifest, an ordered event log, and a
screenshot of the failure that ended it, with no credential, token, or invocation value
anywhere in the record.

Phase 7 adds the other half of the system: a **discovery** loop that is given a goal in
plain language and works out how to achieve it by driving the application one action at a
time. A model observes the current screen, returns a single validated structured decision,
and the application decides whether to honour it. Every proposed action passes the same
Phase 6 policy engine a stored step does, every run is bounded by explicit loop guards,
and every run writes the same sanitized evidence.

**Discovery uses an LLM. Replay does not.** That split is the point of the project, and it
is enforced by an ESLint restriction and by `tests/architecture.test.ts`: nothing under
`src/replay/` may import `src/llm/` or `src/discovery/`.

A successful discovery run produces a structured **trace**, not a capability artifact.
Compiling a trace into a stored, parameterized, replay-tested artifact is Phase 8 and is
deliberately not implemented, so the artifacts in `capabilities/` are still hand-authored.
There is no human handoff yet either: a run that needs a person returns a structured
escalation and stops, which is the seam Phase 9 builds on.

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

## Workflow Discovery

Discovery is given a goal, a target application, and a `ComputerSurface`, and works out
how the goal is achieved by driving the real interface. It is the only part of the system
with a model in its decision loop.

```text
Goal ──▶ Observe ──▶ Model ──▶ Validate ──▶ Policy ──▶ Surface ──▶ Observe ──┐
           ▲                                                                  │
           └──────────────────────────────────────────────────────────────────┘
                                       │
              Goal Completed  ·  Stopped  ·  Escalation Required
```

One turn is one action. The model is never asked to plan a whole workflow up front,
because the point of computer use is that the next decision reacts to what the application
actually did with the last one.

### The Observe, Decide, Act Loop

Each turn does six things in this order:

1. **Observe.** The surface returns a bounded snapshot: URL, title, collapsed visible text,
   and the interactive controls with their roles, accessible names, and enabled state.
   Never raw HTML, cookies, storage, headers, or hidden fields.
2. **Decide.** The observation, the goal, a bounded recent history, and the values read so
   far are sent to the model, which returns one decision.
3. **Validate.** The response is parsed and checked against a Zod schema. There is no cast
   and no partial parse, so an answer that is not a decision cannot become one.
4. **Evaluate.** The validated action goes to the Phase 6 policy engine.
5. **Act.** An allowed action is applied through `ComputerSurface`. Discovery never touches
   Playwright.
6. **Observe again.** The resulting state is fingerprinted, recorded, and fed to the next
   turn.

### Structured Decisions, Never Code

The model returns one of exactly three decisions, and never executable code, a script, or
a selector to evaluate:

```jsonc
{ "type": "action", "action": { ... }, "summary": "Submit the member search form" }
{ "type": "complete", "summary": "The balance is visible", "outputs": { "savingsBalance": "5234.17" } }
{ "type": "escalate", "reason": "The application is asking to approve a payment" }
```

The action vocabulary is the surface's own, and it is closed: `navigate`, `click`, `fill`,
`extract`, `wait`. An action nobody implemented fails validation instead of reaching a
dispatch. Every schema object is a `strictObject`, so an unknown key is rejected, which is
also why there is nowhere for the model to return reasoning even if it wanted to.

Controls are named with the same generic target model a stored artifact uses, so a control
described during discovery is described exactly the way a replayed step describes one:

```json
{
  "description": "Member ID Field",
  "strategies": [
    { "kind": "role", "role": "textbox", "name": "Member ID" },
    { "kind": "label", "text": "Member ID" }
  ]
}
```

### Policy Applies To The Model

Every proposed action is evaluated by the same external policy engine that governs replay,
before it reaches the surface. A model cannot override it, and a summary asserting that an
action is safe carries no authority: the declared risk handed to policy is derived from the
action, never taken from the model.

- **Allowed**: the action is applied.
- **Blocked**: the run stops with `DISCOVERY_POLICY_BLOCKED`, and the action never reaches
  the surface. Exit code 3.
- **Confirmation required**: represented as an escalation, because there is nobody to ask
  yet. Exit code 4.

The opening navigation to the target is checked too.

### Stopping Conditions

Discovery cannot loop forever, and none of these limits is visible to the model as
something it could argue with:

| Condition                | Code                               |
| ------------------------ | ---------------------------------- |
| Step limit reached       | `DISCOVERY_MAX_STEPS_EXCEEDED`     |
| Run deadline             | `DISCOVERY_DEADLINE_EXCEEDED`      |
| Same action repeated     | `DISCOVERY_REPEATED_ACTION`        |
| Screen never changes     | `DISCOVERY_REPEATED_STATE`         |
| Actions keep failing     | `DISCOVERY_DEAD_END`               |
| Policy refused           | `DISCOVERY_POLICY_BLOCKED`         |
| Answer is not a decision | `DISCOVERY_MODEL_RESPONSE_INVALID` |
| Provider failed          | `DISCOVERY_MODEL_UNAVAILABLE`      |
| Surface went away        | `DISCOVERY_SURFACE_UNAVAILABLE`    |
| Completion unsupported   | `DISCOVERY_COMPLETION_UNVERIFIED`  |

Repeated actions are recognized by a fingerprint of the normalized action. A `fill`
contributes a digest of its value rather than the value, so loop protection never carries
somebody's reference into a log. Repeated states are recognized by a deterministic
fingerprint of the sanitized observation structure. That catches the loop that actually
happens, which is an action that changes nothing; it will not catch a loop on a page
carrying a clock or a rotating advertisement, which changes fingerprint every time.

### Completion Is Verified, Not Believed

A model saying "done" is not success. Before a run is reported successful:

- at least one action must have been carried out, and
- every value the model reports must be one the application actually showed, either
  extracted by the surface during the run or visible in the final observation. The
  comparison ignores currency symbols and separators, so `$5,234.17` matches a screen
  showing `5234.17`.

Otherwise the run fails with `DISCOVERY_COMPLETION_UNVERIFIED`.

**Known limitation.** A goal that reads nothing and changes nothing is accepted on the
strength of the summary plus the fact that work happened, because there is no
goal-specific condition to check it against yet. Generating that condition is Phase 8's
job: compiling a run into a capability produces the checkpoint that makes success
mechanically verifiable.

### Discovery Evidence

Every run gets a run ID and writes the same sanitized evidence a replay does, under
`evidence/runs/<runId>/`. The event stream reads as the story of the run:

```text
discovery_started · policy_evaluated · action_started · action_completed
observation_captured · model_request · model_decision · policy_evaluated
action_started · action_completed · … · goal_completed
```

What is **never** written: an API key, a value the run typed in, a value it read out (only
the output names), the text of an observation (only its length and a fingerprint), the
prompt, the raw provider response, or any reasoning the model produced. A model decision
is recorded as its type, the action it names, and the bounded one-line summary the schema
already accepted:

```json
{
  "event": "model_decision",
  "step": 2,
  "decisionType": "action",
  "actionType": "click",
  "action": "click \"Search Button\"",
  "summary": "Submit the member search form"
}
```

That is enforced structurally rather than by convention: `DiscoveryJournal` has no method
that accepts a prompt, a transcript, or a provider response, so no call site can persist
one. The in-memory trace does keep fill values, because Phase 8 needs them to decide what
becomes a capability input, which is exactly why a trace is never serialized to disk or
printed.

### How The Model Is Used

Anthropic is not required. The model boundary is one method:

```ts
interface LLMClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

Two implementations satisfy it, and discovery cannot tell which it was handed:

| Provider    | Where it runs  | Configuration                          |
| ----------- | -------------- | -------------------------------------- |
| `ollama`    | This machine   | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`      |
| `anthropic` | The hosted API | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |

Select one with `LLM_PROVIDER`. The default is `ollama`, so the repository is runnable
with no account and no key. A provider is chosen only in `src/cli/llmClient.ts`; no SDK
import appears anywhere else, which `tests/architecture.test.ts` enforces.

Neither client ever returns anything but the text of the answer. Reasoning content is
dropped at the boundary: the Anthropic client reads text blocks only, and the Ollama client
reads the message content and never the separate field a reasoning model writes beside it.
Provider exceptions are mapped onto domain codes (`MODEL_AUTHENTICATION_FAILED`,
`MODEL_RATE_LIMITED`, `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE`, `MODEL_REQUEST_REJECTED`,
`MODEL_RESPONSE_EMPTY`) with fixed message text, because a provider error can quote the
request it failed on and a request carries an authorization header.

Cost is kept down deliberately: a compact observation plus at most five recent steps rather
than a growing transcript, no screenshots, and a small output ceiling. A provider that can
constrain its decoding to a JSON Schema is given one, derived from the same Zod schema that
validates the answer, so there is no way for the grammar and the validator to disagree.
That constrains shape only; the answer is still parsed and validated either way.

### Running The Live Demo

The controlled application is the demo member console at
`tests/fixtures/member-lookup.html`. Serve it on a local port, then:

```bash
# With a local model (no key, no cost)
ollama serve
ollama pull llama3.1:8b

LLM_PROVIDER=ollama \
POLICY_ALLOWED_HOSTS=127.0.0.1:3100 \
POLICY_ALLOWED_SCHEMES=http \
npm run discover -- \
  --goal "Look Up Demo Member 12345 And Read Their Savings Balance" \
  --target http://127.0.0.1:3100/member-lookup.html \
  --name "Demo Member Lookup"
```

To use Anthropic instead, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

Options: `--goal` (required), `--target` (required), `--name`, `--max-steps`, `--timeout`,
`--headed`. Exit codes are `0` success, `1` failure, `3` blocked by policy, `4` escalation
required. The structured result goes to stdout and run events to stderr, so
`npm run discover -- … | jq` reads a single JSON document. No key and no value the run typed
appears on either stream.

The live path is the only thing in the repository that needs a model. The whole test suite
mocks the `LLMClient` boundary and runs with no provider of any kind, so CI never spends a
credit.

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
`cause` is a rendered one-line summary with no stack. Invocation values are never logged,
and only input _names_ appear in the run record.

## Execution Results

A capability that only works on the happy path is not useful in production, so a replay
says exactly what happened when it did not.

### The Happy Path

```text
Valid Artifact -> Valid Inputs -> All Steps Execute -> All Checkpoints Pass
  -> Outputs Produced -> Success Condition Passes -> Success
```

Every part of that is required. A run is never called a success because nothing threw.

### The Four Distinctions

```text
Success                a normal completion, with the declared outputs
Business Outcome       a known application answer, such as MEMBER_NOT_FOUND
Recoverable Condition  a state the capability recognizes and knows how to clear
Hard Failure           a state replay will not push past, so it stops
```

Three of those are ways a run can end; a recoverable condition is something that happens
_during_ one. A condition that clears ends as a success, and a condition whose bounded
recovery runs out ends as a failure with `kind: "recoveryExhausted"`. Reporting a run as
"recoverable" after the engine has already exhausted its recovery would tell a caller to
do what the engine just tried, so every result carries the `recoveries` it performed
instead, and a failure says through `kind` which sort it is.

The result contract is therefore three statuses, and a `switch` over them is exhaustive:

```json
{ "status": "success", "capabilityId": "lookup-demo-member",
  "outputs": { "memberName": "Ada Lovelace", "savingsBalance": 5234.17 }, "recoveries": [] }

{ "status": "businessOutcome", "code": "MEMBER_NOT_FOUND",
  "message": "The demo console reports that no member matches the supplied id.",
  "stepId": "await-member-summary" }

{ "status": "failure", "kind": "terminal", "code": "PERMISSION_DENIED",
  "message": "The signed-in operator is not permitted to view this member...",
  "stepId": "await-member-summary" }

{ "status": "failure", "kind": "recoveryExhausted", "code": "REPLAY_RECOVERY_EXHAUSTED",
  "stepId": "await-member-summary", "attempts": 1,
  "expected": "Target \"Member Summary Region\" Is Visible", "observed": "Not Visible" }
```

Optional fields appear only when they mean something. No result is padded with nulls.

### Error Codes

Codes are for machines and messages are for people, so a caller branches on the code and
never on the wording. Engine codes are prefixed `REPLAY_` and artifact-declared codes are
not, which answers the first question a reader has about a code in a result: did the
engine work this out, or did the capability declare it?

| Engine Code                       | Means                                             |
| --------------------------------- | ------------------------------------------------- |
| `REPLAY_INPUTS_INVALID`           | The invocation did not match the declared inputs  |
| `REPLAY_PARAMETER_UNRESOLVED`     | A value reference named an input nobody supplied  |
| `REPLAY_TARGET_NOT_FOUND`         | No locator strategy matched                       |
| `REPLAY_AMBIGUOUS_TARGET`         | Several matched and none matched exactly one      |
| `REPLAY_TARGET_INVALID`           | The stored target cannot be resolved at all       |
| `REPLAY_NAVIGATION_FAILED`        | The surface could not reach the location          |
| `REPLAY_ACTION_FAILED`            | The control resolved but the interaction did not  |
| `REPLAY_CHECKPOINT_FAILED`        | A `checkpoint` step asserted a state that was not |
| `REPLAY_WAIT_TIMEOUT`             | A `wait` step's state never arrived               |
| `REPLAY_STEP_TIMEOUT`             | The step outlived its whole budget                |
| `REPLAY_SUCCESS_CONDITION_FAILED` | Every step ran, the success state was not reached |
| `REPLAY_OUTPUT_EXTRACTION_FAILED` | The target resolved but nothing could be read     |
| `REPLAY_OUTPUT_MISSING`           | A declared output was never produced              |
| `REPLAY_OUTPUT_TYPE_MISMATCH`     | The text could not be read as the declared type   |
| `REPLAY_OUTPUT_UNDECLARED`        | A step assigned to an output nobody declared      |
| `REPLAY_RECOVERY_EXHAUSTED`       | A recognized condition would not clear            |
| `REPLAY_SURFACE_UNAVAILABLE`      | The surface went away mid-run                     |
| `REPLAY_UNEXPECTED_STATE`         | Genuinely unclassifiable, and never a dumping bin |

### Declaring What The Application Says

The capability declares which of its application's messages are answers and which are
stops, because only its author knows. An engine that guessed would be classifying by
matching page text against a list baked into it:

```json
{
  "businessOutcomes": [
    {
      "code": "MEMBER_NOT_FOUND",
      "disposition": "businessOutcome",
      "condition": { "type": "textVisible", "text": "No Member Matches That Reference" }
    },
    {
      "code": "PERMISSION_DENIED",
      "disposition": "failure",
      "condition": {
        "type": "textVisible",
        "text": "You Do Not Have Permission To View This Member"
      }
    }
  ]
}
```

A permission denial is a **hard failure** rather than a business outcome: the workflow did
not answer the question it was asked, and the automation is not authorized to proceed, so
a caller must not treat it as a result to act on. An expired session is the same, because
this capability has no safe deterministic way to sign in again. An application validation
message would be a business outcome if the artifact declares it as one; nothing is
categorized by default.

Declared states are only looked for after a `wait` or `checkpoint` condition did not hold,
or after the success condition failed. A control that could not be found or operated is an
automation problem whatever the screen says.

### Recoverable Conditions

A retry says "try that again". A recovery says "we recognize the state the application is
in, and we know the single control that clears it". The knowledge lives in the artifact:

```json
{
  "recoveries": [
    {
      "code": "KNOWN_SESSION_DIALOG",
      "condition": {
        "type": "targetVisible",
        "target": { "description": "Session Warning Dialog", "strategies": [] }
      },
      "action": {
        "type": "dismiss",
        "target": { "description": "Session Warning Continue Button", "strategies": [] }
      },
      "maxAttempts": 2
    }
  ]
}
```

Replay clears the state, retries the step that failed, and records what it did. It is
bounded three ways: only failures an interstitial could plausibly cause are eligible, only
a step that is safe to repeat is retried, and each condition may fire only as many times
as the artifact allowed. **An interstitial the artifact does not declare is never touched**
and stops the run, which matters most in exactly the applications this project is aimed at.

### Trying The Scenarios

The fixture reaches every runtime condition from one member id, so a scenario is named by
the value you supply:

| Member ID | What Happens                     | Result                                      |
| --------- | -------------------------------- | ------------------------------------------- |
| `12345`   | Normal lookup                    | `success`                                   |
| `00000`   | No such member                   | `businessOutcome` `MEMBER_NOT_FOUND`        |
| `99999`   | Not permitted to view            | `failure` `PERMISSION_DENIED`               |
| `55555`   | Session has expired              | `failure` `SESSION_EXPIRED`                 |
| `77777`   | Known session warning            | `success`, recovered `KNOWN_SESSION_DIALOG` |
| `88888`   | Request did not land             | `success`, recovered `TRANSIENT_LOAD`       |
| `44444`   | Known warning that never clears  | `failure` `REPLAY_RECOVERY_EXHAUSTED`       |
| `66666`   | An interstitial nothing declares | `failure` `REPLAY_WAIT_TIMEOUT`             |
| `24680`   | A balance the type cannot hold   | `failure` `REPLAY_OUTPUT_TYPE_MISMATCH`     |

To run one, point a copy of the example artifact at the local fixture and invoke it. Run
events go to stderr and the result is the whole of stdout, so the output pipes into `jq`:

```bash
npm run replay -- --artifact ./local-member.json --input memberId=99999 | jq '.code'
```

Exit codes stay as they were: `0` for success, `2` for a business outcome, `1` for a
failure.

## Safety Guardrails

The automation never decides its own permissions.

```text
Capability Says:  "This Action Is Risky"
Policy Says:      "Risky Actions Require Confirmation"
                = Confirmation Required, And The Action Does Not Happen
```

There is no path where an artifact saying `"risk": "safe"` grants itself anything. The
authority is `src/policy/`, configured by whoever operates the deployment, and every
action passes through it before it reaches `ComputerSurface`.

### Where The Check Happens

```text
Replay / Future Discovery
        |
   Proposed Action ---> Policy Engine ---> blocked: structured result, run stops
        |                                  allowed: continue
        v
  ComputerSurface
```

One gate, in `StepExecutor`, evaluated once per attempt before the switch that dispatches
the step. A blocked action results in **zero calls** to the surface, which is asserted
directly rather than assumed. The engine requires a policy: there is no constructor
option that turns the guardrail off, because that is the mode that ships by accident.

### Deny By Default

| Situation                 | Result                                     |
| ------------------------- | ------------------------------------------ |
| Host not on the allowlist | Blocked                                    |
| Empty allowlist           | Blocked, not "everything"                  |
| Scheme not permitted      | Blocked (`javascript:`, `data:`, and rest) |
| Action type not permitted | Blocked                                    |
| Risk level not recognized | Blocked                                    |
| Unparseable URL           | Blocked                                    |

Out of the box the policy reaches **nothing**, over `https` only, asks before anything
risky, and refuses anything irreversible. A deployment states what it needs.

### Domains And Routes

URLs are parsed and compared, never substring-matched: `https://localhost.attacker.example`
does not satisfy an allowlist containing `localhost`. Hostnames are lower-cased and the
trailing dot a resolver ignores is ignored here too. An entry may pin a port
(`localhost:3000`) or match any port on that host. There are no wildcards.

`localhost`, `127.0.0.1`, and `[::1]` stay **distinct**. They are one machine and three
names, and treating one entry as permission for the others is how an allowlist grows a
hole nobody wrote down.

Route prefixes are optional and match on segment boundaries, so `/members` covers
`/members/42` and not `/membersecret`. A scheme with no host (`file:`, used by the local
fixture) has no domain allowlist protecting it, so for those the route list is required
and an empty one refuses everything.

After a navigation, the URL the surface actually landed on is checked again. A permitted
destination that redirects somewhere else stops the run.

### Risk

Risk comes from the Phase 3 artifact metadata, deterministically. Nothing infers it from
button text.

| Declared Risk  | Default Behavior      | Result Code                         |
| -------------- | --------------------- | ----------------------------------- |
| `safe`         | Allowed               | -                                   |
| `risky`        | Confirmation required | `POLICY_RISK_CONFIRMATION_REQUIRED` |
| `irreversible` | Blocked               | `POLICY_RISK_BLOCKED`               |

Confirmation required means the run **stops**. There is no approval queue and no fake
approval: a person cannot be asked yet, so the action does not happen. Human control
transfer is Phase 9.

### Policy Denial Codes

`POLICY_URL_INVALID`, `POLICY_SCHEME_NOT_ALLOWED`, `POLICY_DOMAIN_NOT_ALLOWED`,
`POLICY_ROUTE_NOT_ALLOWED`, `POLICY_ACTION_NOT_ALLOWED`,
`POLICY_RISK_CONFIRMATION_REQUIRED`, `POLICY_RISK_BLOCKED`.

A denial is a `failure` result with `kind: "policy"`, which is how a caller tells "the
automation could not do this" from "the automation was not permitted to do this". They
are different incidents: one is a defect, the other is the system working. The CLI exits
`3` for a policy block, distinct from `1` for a failure.

### Configuring Local Development

Policy is environment configuration, so changing the allowlist never means editing source.
`.env.example` ships a local development policy; copy it to `.env`:

```bash
POLICY_ALLOWED_HOSTS=localhost,127.0.0.1
POLICY_ALLOWED_SCHEMES=https,http
POLICY_ALLOWED_ROUTES=
POLICY_ALLOWED_ACTIONS=navigate,click,fill,extract,wait,checkpoint
POLICY_RISK_SAFE=allow
POLICY_RISK_RISKY=requireConfirmation
POLICY_RISK_IRREVERSIBLE=block
```

To replay against the local HTML fixture, which is a file rather than a served page:

```bash
POLICY_ALLOWED_SCHEMES=file POLICY_ALLOWED_ROUTES="$PWD/tests/fixtures" \
  npm run replay -- --artifact ./local-member.json --input memberId=12345
```

A production deployment allows `https` only.

## Run Evidence

Every replay writes a sanitized record of what it did.

```text
evidence/runs/<runId>/
  metadata.json      capability, policy in force, outcome, warnings
  events.jsonl       one JSON document per line, in order
  screenshots/
    001-replay-wait-timeout.png
```

The run id is a UUID, generated locally, never derived from an input, and it is the same
identifier the result reports as `replayId`, so a result and its evidence need no
correlation by timestamp.

### Events

```json
{"timestamp":"...","runId":"...","event":"step_started","stepId":"enter-member-id","stepType":"fill"}
{"timestamp":"...","runId":"...","event":"policy_evaluated","stepId":"enter-member-id","actionType":"fill","outcome":"allow"}
{"timestamp":"...","runId":"...","event":"step_completed","stepId":"enter-member-id","durationMs":23}
```

The vocabulary is closed: `run_started`, `policy_evaluated`, `policy_blocked`,
`step_started`, `step_completed`, `step_failed`, `checkpoint_passed`, `checkpoint_failed`,
`business_outcome_detected`, `recovery_attempted`, `recovery_exhausted`,
`screenshot_captured`, `run_completed`.

**Every** policy decision is recorded, not only the refusals, because "was this allowed?"
is one of the questions evidence exists to answer and a record listing only refusals
cannot tell a permitted action from an unchecked one.

### What Is Never Written

- invocation values: only input **names** reach evidence, and the fill value that was
  typed appears nowhere
- credentials, tokens, cookies, authorization headers, API keys, session identifiers
- URL query **values** (the names survive so the shape of a request is visible), URL
  fragments, and credentials embedded in a URL
- stack traces

Redaction lives in `src/redaction.ts` and is shared with the logger, so a secret cannot be
scrubbed from the durable record and printed to a terminal.

### Screenshots

One screenshot per run, taken at the failure that ended it, named after the failure code
(`001-policy-domain-not-allowed.png`). Not one per step: that would be mostly identical
images and a much larger chance of storing something sensitive.

**A screenshot is a picture of the application, so it may contain whatever the application
was displaying.** There is no visual redaction here and none is claimed. The fixture uses
synthetic data, and a production deployment would need stronger screenshot handling, or
none at all.

Checkpoint observations are recorded only when the checkpoint failed, where the excerpt is
the diagnosis. A passing checkpoint records that it passed and nothing about what was on
screen.

### Evidence Failures

A run's result never changes because evidence could not be written. An event or a
screenshot that fails becomes a warning on the manifest and the CLI prints it. A manifest
that cannot be written throws, because a run directory that says nothing about the run is
an observability failure worth hearing about rather than burying.

### Inspecting A Run

```bash
npm run replay -- --artifact ./local-member.json --input memberId=12345
```

```text
Replay Completed

  Run ID:   7fe03cef-34e8-473c-a778-3a8211cf56cc
  Status:   Success
  Evidence: evidence/runs/7fe03cef-34e8-473c-a778-3a8211cf56cc
```

```bash
cat evidence/runs/<run-id>/metadata.json
jq -c '{event, stepId, outcome, code}' evidence/runs/<run-id>/events.jsonl
open evidence/runs/<run-id>/screenshots/
```

The summary goes to stderr and the machine-readable result to stdout, so the result still
pipes into `jq` cleanly.

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

| Variable           | Required | Default        | Purpose                                          |
| ------------------ | -------- | -------------- | ------------------------------------------------ |
| `LOG_LEVEL`        | No       | `info`         | One of `debug`, `info`, `warn`, `error`.         |
| `EVIDENCE_DIR`     | No       | `evidence`     | Where run evidence is written.                   |
| `CAPABILITIES_DIR` | No       | `capabilities` | Where capability artifacts are read and written. |

The model, used by discovery and by nothing else:

| Variable               | Required             | Default                  | Purpose                                    |
| ---------------------- | -------------------- | ------------------------ | ------------------------------------------ |
| `LLM_PROVIDER`         | No                   | `ollama`                 | `ollama` or `anthropic`.                   |
| `OLLAMA_BASE_URL`      | No                   | `http://127.0.0.1:11434` | Where the local runtime listens.           |
| `OLLAMA_MODEL`         | No                   | `llama3.1:8b`            | Which local model answers.                 |
| `ANTHROPIC_API_KEY`    | Only for `anthropic` | none                     | Hosted model access. Replay never uses it. |
| `ANTHROPIC_MODEL`      | No                   | `claude-sonnet-5`        | Which hosted model answers.                |
| `DISCOVERY_MAX_STEPS`  | No                   | `15`                     | Model decisions one run may carry out.     |
| `DISCOVERY_TIMEOUT_MS` | No                   | `180000`                 | Wall-clock ceiling for one discovery run.  |

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
  credentials. Only `LLM_PROVIDER=anthropic` requires one, and it fails with an explicit
  message when it is absent. The default provider is local, so nothing in the repository
  needs an account.
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
| `npm run discover`      | Discovers a workflow with a model, see Workflow Discovery         |
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
| `tests/replay/browserScenarios.test.ts`    | Every runtime condition, driven through a real browser     |
| `tests/architecture.test.ts`               | Replay, Playwright, and artifact dependency boundaries     |

`browserReplay.test.ts` is the Phase 4 proof: it loads
`capabilities/examples/lookup-demo-member.json` through the real validator, points it at
`tests/fixtures/member-lookup.html`, and runs it through `ReplayEngine`, `StepExecutor`,
`ComputerSurface`, and `PlaywrightSurface` to a successful set of outputs. It covers a
parameter change, a declared business outcome, an output the declared type cannot hold,
a failing checkpoint, and a failing success condition. It calls no model and reaches no
network.

`browserScenarios.test.ts` is the Phase 5 proof, and drives every row of the scenario
table above through the same chain: an answer, two declared stops, two recoveries, an
exhausted recovery, an interstitial nothing declares, and an unreadable output. It also
asserts that the unknown dialog is still on screen and unapproved afterwards.

The replay suites that are about the engine rather than a browser run in milliseconds
against a scripted surface:

```bash
npm run test -- tests/replay
```

| Suite                                      | Covers                                                       |
| ------------------------------------------ | ------------------------------------------------------------ |
| `tests/policy/policy.test.ts`              | Allowlists, schemes, routes, risk, and bypass attempts       |
| `tests/evidence/redaction.test.ts`         | Redaction rules, and that the logger applies the same ones   |
| `tests/evidence/recorder.test.ts`          | Manifests, JSONL, screenshots, path safety, write failures   |
| `tests/replay/policyIntegration.test.ts`   | Policy runs before the surface, and blocked means zero calls |
| `tests/replay/evidenceIntegration.test.ts` | A real run's evidence for each outcome                       |
| `tests/replay/inputs.test.ts`              | Input validation and parameter resolution                    |
| `tests/replay/engine.test.ts`              | Ordering, checkpoints, success condition, retries, budgets   |
| `tests/replay/outputs.test.ts`             | Output typing, conversion refusals, and the output contract  |
| `tests/replay/classification.test.ts`      | Every surface error to a code, and what never leaks out      |
| `tests/replay/outcomes.test.ts`            | Business outcomes, declared failures, undeclared states      |
| `tests/replay/recovery.test.ts`            | Recognition, bounded recovery, exhaustion, and refusals      |

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
  discovery/            LLM-driven exploration loop (Phase 7)
  evidence/             Sanitized run records: manifest, events, screenshots
    FileEvidenceRecorder.ts  One directory per run, written atomically
    types.ts            The closed event vocabulary and the recorder contract
  execution/            Action vocabulary and executor, the shared waist (Phase 7)
  handoff/              Human handoff (Phase 9)
  llm/                  Provider-agnostic model boundary
    anthropic/          Anthropic implementation (Phase 7)
  logging/              Structured JSON logger with redaction
  policy/               The safety boundary, evaluated before every action
    StaticPolicyEngine.ts    Pure evaluation of a context against configuration
    config.ts           What a deployment permits, validated and safe by default
    url.ts              Parsed-URL allowlisting, never substring matching
  replay/               Deterministic artifact execution, never imports llm/
    ReplayEngine.ts     Validate, execute in order, verify, collect, return a result
    StepExecutor.ts     One step against the surface, with bounded attempts
    classification.ts   The one place a surface error becomes a stable code
    policyGate.ts       A step described to policy, and a denial described to the run
    RunJournal.ts       One call site per event, written to the log and to evidence
    RecoveryPlanner.ts  Recognizes a declared condition and clears it, bounded
    CheckpointEvaluator.ts  Conditions, keeping expected next to observed
    InputValidator.ts   Invocation inputs against the declared inputs
    ParameterResolver.ts    Literal or declared input, and nothing else
    OutputCollector.ts  Extracted text into the declared output types
    deadlines.ts        The budget hierarchy and the outer bound
    ReplayResult.ts     Success, business outcome, failure, and the code vocabulary
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
  redaction.ts          The one set of redaction rules, shared by logger and evidence
tests/                  Vitest suites
  artifacts/            Schema, serialization, and artifact store suites
  evidence/             Redaction rules and the run recorder
  policy/               The safety boundary and its bypass regression tests
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
| 5     | Execution results, error taxonomy, business outcomes, recovery       | Done    |
| 6     | Policy guardrails and sanitized run evidence                         | Done    |
| 7     | LLM-driven discovery loop, provider abstraction, discovery CLI       | Done    |
| 8     | Compiling a discovery trace into a capability artifact               | Next    |
| 9     | Escalation into a live human handoff                                 | Planned |

## Design Notes

See [REPORT.md](REPORT.md) for the architecture write-up, artifact schema, determinism
and error handling, escalation, safety, and the scope cuts that were made.
