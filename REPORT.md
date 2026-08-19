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

## Why The Surface Answers Conditions

`ComputerSurface` gained one method in Phase 4: `waitFor(condition)`, answering whether a
target is visible, whether it contains some text, whether some text is on screen, or
whether the location matches.

It went there rather than into replay because of what the alternative would have cost.
Replay can only ask a surface what it exposes, and the acting methods answer the wrong
question: `resolve` insists on exactly one match, which is right for deciding what to
click and wrong for asking whether something is displayed. Building a state check out of
`extract` and `observe` would also have meant polling, and a polling interval inside
replay is precisely the clock-based waiting the whole surface layer exists to avoid. Only
an implementation can wait on a state natively.

The condition model therefore lives in `surfaces/types.ts`, and the artifact's
`checkpointSchema` parses into it, checked by the same compile-time alias that ties a
stored target to `Target`. One model, two readers, no conversion layer, and no chance of
the two drifting apart. Every method also gained an optional per-call `timeoutMs`, which
is what lets a stored step say it legitimately takes longer without slowing the surface
down for everything else.

## How Replay Is Layered

```text
Capability Artifact -> ReplayEngine -> StepExecutor -> ComputerSurface -> PlaywrightSurface
```

Each arrow points at something that knows less about the workflow than its caller. The
engine owns the sequence and the result. The executor owns one step and its attempts, and
decides nothing about the workflow. The surface owns translation and waiting. Nothing in
`src/replay/` imports Playwright, `src/llm/`, `src/discovery/`, or a model SDK, and the
only surface import the whole package makes is `../surfaces/index.js`, which
`tests/architecture.test.ts` asserts directly.

`src/execution/` stays empty. It is meant to be the shared waist between discovery and
replay, and with one caller a shared waist is an abstraction with nothing on the other
side of it. It earns its place when discovery arrives.

## Where Classification Lives

Phase 5 added one module and moved no responsibility. `classification.ts` is the only
place in the engine that names a surface error type, and `RecoveryPlanner` is the only
place that activates a control the workflow did not ask for. Both sit below
`ReplayEngine`, which asks them questions and decides nothing about locators or browsers
itself.

That keeps the layering from Phase 4 intact:

```text
Capability Artifact -> ReplayEngine -> StepExecutor -> ComputerSurface -> PlaywrightSurface
                            |
                            +-- classification.ts   surface error to stable code
                            +-- RecoveryPlanner     declared condition to declared control
```

The architecture test now also asserts that these two modules and the engine mention no
model provider at all, in source as well as in imports. Recovery is the one place in the
system that reacts to a failure by doing something, so it is where an AI fallback would
first appear, and it is worth an explicit guard rather than a convention.

## Where The Safety Boundary Sits

Policy and evidence sit _below_ everything that executes anything, not beside replay:

```text
        Replay              Discovery (Phase 7)
           |                     |
           +----------+----------+
                      |
                Policy Engine          decides, touches nothing
                      |
               ComputerSurface
                      |
              Evidence Recorder        records, decides nothing
```

The engine is handed a `PolicyContext` describing a proposed action and returns a
decision. It has no idea who proposed it, which is the whole point: when the discovery
loop arrives it builds the same context for a model-proposed action and gets the same
answer from the same code. A second, weaker boundary for the LLM path is the failure mode
this shape exists to prevent, and an ESLint rule plus an architecture test keep both
packages from importing replay, discovery, or a model SDK.

Two consequences follow from the engine being pure and synchronous. It cannot fail open,
because there is nothing in it to fail: no file read, no network call, no clock. And it is
testable as a table of questions and answers, which matters for the one component whose
correctness everything else assumes.

Enforcement lives in `StepExecutor`, evaluated once per attempt before the switch that
dispatches the step. One gate rather than a check inside each step implementation, so a
seventh step type cannot be added that quietly skips it.

## Where The Artifact Sits

The capability artifact is the waist of the pipeline: discovery writes it, replay reads
it, and neither knows about the other. `src/artifacts/` therefore depends on neither
side, nor on a model SDK, and its only outward dependency is the surface target model.
That is the third boundary enforced twice, by a scoped ESLint rule and by
`tests/architecture.test.ts`, alongside `replay` to `llm` and Playwright to its adapter.

The direction of the dependency is what matters. The artifact does not import an
executor, and the executor will import the artifact. A workflow can therefore be
reviewed, diffed, and validated by a process that can neither open a browser nor call a
model.

## Why The Model Exists Only In Discovery

The central claim of the system is that reasoning is a one-time cost. A model is expensive,
slow, and non-deterministic; a workflow, once understood, is none of those things. So the
model is spent once working out how a goal is achieved, and the result is executed
afterwards by an engine with no model in it.

That is a boundary, not an intention, and it is enforced three ways. `src/replay/` may not
import `src/llm/` or `src/discovery/` under a scoped ESLint rule. `tests/architecture.test.ts`
asserts the same thing from the import graph, so the build fails even if the lint config
drifts. And a third test reads the recovery paths specifically, because that is the one
place an LLM fallback would plausibly appear: the file that decides what to do about a
failure is the file most likely to acquire an "ask the model" branch. Replay failing and
then asking a model would collapse the distinction the project exists to demonstrate.

## The Provider Abstraction

`LLMClient` is one method that takes text and returns text. It knows nothing about goals,
observations, decisions, or policy, which is what makes the isolation real rather than
nominal: a second provider implements two shapes and one method and has nowhere to put a
vendor concept.

There are two implementations. `AnthropicClient` is the only file that imports the SDK.
`OllamaClient` speaks to a model running on the operator's own machine over one HTTP POST
with no SDK at all. Discovery imports neither; a composition root under `src/cli/` picks
one from configuration, and a test asserts that an SDK import appears nowhere else in
`src/`.

Having two was worth the small cost, because one implementation cannot demonstrate that an
abstraction abstracts anything. It also means the repository is runnable, and the live
demonstration reproducible, with no account and no credential.

Both clients return the text of the answer and nothing else. `ModelResponse` has no field
for a raw body, a transcript, or reasoning, so there is no path by which one could reach
evidence. That is a stronger guarantee than a rule saying not to persist them.

## Structured Decisions Instead Of Generated Code

The model never returns code. It returns one of three objects, validated against a Zod
schema before anything acts on it, and the action vocabulary is derived from what
`ComputerSurface` can actually do rather than from what a model might imagine. An action
name nobody implemented fails validation instead of reaching a dispatch that would have to
decide what to do with it.

Every schema object is a `strictObject`. That is a typo guard, and it is also structural:
there is no field in which a model could return a script, a selector to evaluate, or its
own reasoning, so nothing downstream has to remember not to read one.

A compile-time assertion ties the two vocabularies together. Every agent action type must
also be a `CapabilityStepType`, because policy evaluates the latter; if an action were
added that the guardrail had no name for, the constraint would stop compiling rather than
let an action through a check that could not describe it.

## Why Compilation Is Its Own Boundary

A discovery trace and a capability artifact answer different questions. The trace says what
happened during one run, in the order it happened, including the attempts that failed and
the concrete values that were typed. The artifact says how the capability is performed, for
every future caller. Serializing the first and calling it the second would produce a file
that looks like a workflow and replays one member's lookup forever.

So compilation is a real transformation with its own module, and it is deterministic. The
same trace and the same request produce the same artifact byte for byte, and no model is
involved: an ESLint rule and an architecture test both refuse an SDK import under
`src/compilation/`. That matters because the project's claim is that reasoning is a
one-time cost. A compiler that called a model would put one back between the run and the
artifact, and the artifact would stop being reproducible from its inputs.

The dependency direction is the other half of it. Compilation imports replay, because it
verifies by replaying. Replay imports nothing from compilation, discovery, or the model
layer, so the executor never learns how a workflow was authored. That rule is enforced
twice, by lint and by test, and it is what lets a capability be handed to a replay engine
that has never heard of a model.

## How Observations Are Represented

An observation is a bounded summary: URL, title, collapsed visible text, and the
interactive controls with their roles, accessible names, and enabled state. Not raw HTML,
not the DOM, not cookies or storage or headers.

Three reasons, in order of weight. A full page would carry data nobody meant to send to a
provider. It would cost more per turn than the decision is worth, and the cost is paid on
every turn of every run. And it would be worse input: a model choosing between eleven named
controls is doing an easier job than one reading a thousand lines of markup.

The representation stays compatible with a surface that has no clean DOM, because it is
expressed in roles and names rather than in elements. A surface driven by an accessibility
tree or by coordinates can produce the same shape.

# Artifact Schema

A capability artifact is one workflow, frozen into a JSON document: the ordered steps,
the control each one acts on, the values a caller supplies, the values the workflow
returns, and the checkpoint that proves it reached the state it was recorded to reach.
The shape is in [README.md](README.md#capability-artifacts); the reasoning is here.

## Why It Is Independent Of The Model

Discovery uses an LLM to find a workflow. That is the expensive, non-deterministic,
provider-specific part, and none of it belongs in the result. If an artifact carried
Claude messages, tool-use blocks, or a reasoning trace, then replaying it would mean
re-interpreting a model's output, changing providers would mean rewriting every stored
workflow, and reviewing one in a pull request would mean reading a transcript instead of
a procedure. It would also be the most likely place for a captured form value or a
prompt containing customer data to end up on disk.

So the artifact is a description of a procedure and nothing else. It contains no model
identifier, no prompt, no transcript, and no discovery-time reasoning. `src/artifacts/`
imports no model SDK, and nothing in it can. Discovery's job is to produce this document;
what it thought along the way is evidence, not contract.

## Why Steps Are A Discriminated Union

A `fill` needs a value and a `click` does not; an `extract` names an output and a
`navigate` names a URL. The alternative, an action name plus a `data` bag, pushes that
knowledge into every reader: the validator cannot say which combination is meaningful,
the compiler cannot narrow, and a step with a value but no target is accepted and fails
later in front of the application.

The union states each shape exactly. `steps[0].type` is checked against the six supported
types before anything else in the step is read, so an unsupported step fails with a
message naming the six rather than a cascade of shape errors. Every object is a Zod
`strictObject`, so a field belonging to a different step type is rejected rather than
stripped. That is a typo guard, and it is also why unmodelled data cannot be smuggled
into a stored artifact: there is no field for it, and adding one fails validation.

The six are `navigate`, `click`, `fill`, `extract`, `wait`, and `checkpoint`. Nothing was
added for a workflow that does not exist yet. There is deliberately no sleep step: a wait
carries a state condition, because a fixed delay is not synchronization and, once it is
available, it becomes the way every timing problem gets solved.

## Schema Version Versus Capability Version

Two versions that answer different questions, and conflating them would make both
useless.

`schemaVersion` is a string, currently `"1"`, and describes the file format. It is
checked before the shape is, so an artifact written by a future build fails with
"unsupported artifact schema version" instead of fifty shape errors from a schema that
does not apply to it. That check is the migration hook: a later build can read the
version, decide it holds a v1 document, and upgrade it before parsing. Only the current
version is supported today.

`version` is an integer and describes this capability's revision. It increments when the
workflow is re-recorded or repaired, for instance after the application moved a button.
The file format is unchanged in that case, and a reader that understands `"1"` still
understands the new revision.

## Why Inputs And Outputs Are Typed

A capability is meant to be called, by a person or by an agent, and a caller should not
have to read the steps to learn what to pass or what comes back. Declared inputs and
outputs make the invocation contract readable on its own, and they give a later replay
somewhere to reject a bad invocation before it touches the application, which is the
cheapest possible failure.

The type set is `string`, `number`, `boolean`. Nested objects, arrays, unions, dates, and
enums were all considered and cut: each would need a resolution rule in replay that
nothing currently requires, and an unused type in a contract is a promise someone will
eventually try to call in. Enums are the closest call, since a "choose an account type"
input is plausible, but a string input plus a literal value covers it today, and adding
an enum later is an additive change to one union.

Steps do not hard-code values that vary per invocation. One value model covers every
step that needs one:

```json
{ "source": "literal", "value": "Checking" }
{ "source": "input", "name": "customerReference" }
```

A structured reference was chosen over a `{{ inputs.customerReference }}` template on
purpose. A template is a string that needs a parser, fails at replay time rather than at
review time, and cannot be checked against the declared inputs without that parser; it
also tends to grow conditionals and filters until it is a language. A reference is data,
so validation proves it points at an input that exists, and a reviewer can see at a
glance which values come from the caller.

## Why Targets Reuse The Phase 2 Model

The artifact stores `Target` and `LocatorStrategy` exactly as `src/surfaces/types.ts`
defines them: a description plus an ordered list of role, label, placeholder, attribute,
text, and CSS strategies. The schema parses into those types rather than into a lookalike,
and a type constraint in `steps.ts` fails to compile if the two ever drift apart.

A second representation would have to be converted at replay time, and a conversion is
exactly where a recorded resolution order quietly becomes a different one. Reusing the
model also means a stored target is browser-independent for free: no Playwright selector
and no `Locator` is ever serialized, and the role vocabulary the artifact validates
against is the surface's own list rather than a copy.

The order strategies are stored in is the order a resolver attempts them, so resolution
during replay is the same computation it was during discovery.

## Why Checkpoints Are Explicit

An action that did not throw is not a workflow that worked. A click can succeed against a
button that no longer submits anything; a page can return HTTP 200 and show an error. A
replay that only reports "no step threw" is asserting nothing about the business process.

So `successCondition` is required. It is the reason an artifact is worth trusting: it
states the observable condition that means the workflow reached its intended state, and a
run that does not satisfy it is a failure regardless of how smoothly the steps went.

One checkpoint model serves four jobs: the success condition, a `wait` step's condition,
a `checkpoint` step's assertion, and a business outcome's condition. They ask the same
question, so they share one schema rather than three near-identical ones. Four condition
types exist because four cover what the surface can currently observe: `targetVisible`,
`targetContainsText`, `textVisible`, and `urlMatches`. A `urlMatches` pattern is compiled
and length-bounded at parse time, so a broken regular expression is an artifact defect
found in review rather than an exception thrown mid-replay.

Wait and checkpoint steps are kept separate even though both hold a condition, because
their failures mean different things: a wait that expires means the state never arrived,
and a checkpoint that fails means the workflow went somewhere else. The later error
taxonomy needs that distinction.

## How Business Outcomes Are Represented

"No customer matches that reference" is an answer, not a crash. Treating it as a failure
produces false escalations, retries of a workflow that already worked, and an operator
looking for a bug that does not exist.

A capability declares the answers it knows about:

```json
{
  "code": "CUSTOMER_NOT_FOUND",
  "description": "The demo console reports that no customer matches the supplied reference.",
  "condition": { "type": "textVisible", "text": "No Customer Matches That Reference" }
}
```

A machine-readable `code` for a caller to branch on, a description for a person, and a
condition reusing the checkpoint model. Codes must be unique within a capability.
Detection is not implemented: Phase 3 only makes the artifact able to express it, so
that a later run can end with a declared outcome instead of an escalation.

## Retry And Timeout Metadata

Steps may carry an optional `execution` block with `timeoutMs` and `retry.maxAttempts`.
It was included because two cases are real and cannot be solved by a global default: a
screen that legitimately takes longer than the surface budget, such as a report rendered
on demand, and a control known to need a second attempt. Encoding those as one global
timeout would slow every step down to the speed of the worst one.

It was kept tiny for the opposite reason. Replay owns the defaults; the artifact only
records where a step differs. Attempts are capped at three, there is no backoff curve, no
jitter, and no per-error-class policy. A step that cannot succeed in a few attempts is a
workflow that has changed, which is an escalation rather than something to retry harder.
Operational policy belongs to the engine and its configuration, not to a document that
gets committed once and read for months.

## How A Discovered Value Becomes A Parameter

Discovery types concrete strings, and a finished trace cannot say which of them were
invocation data. Inferring it from the shape of a string finds the value the caller meant
and eventually also finds one they did not, and a wrongly parameterized workflow constant
is a capability that breaks the first time it is invoked for real.

So the grounding is explicit. The caller names the values with `--input memberId=12345`,
discovery is shown them so it types exactly those, and the compiler binds on exact
whole-value equality. Everything else stays a literal, which is the right answer for the
parts of a workflow that never vary. Two inputs sharing a value is a compilation failure
rather than a coin flip, and so is an input the run never typed.

The supplied value never reaches the artifact. Only the name does, which is what keeps a
member reference out of a file that gets committed and reviewed.

## Why An Output Is An Instruction

The artifact stores an extract step and a declared output, never the value the discovery
run read. An artifact carrying `"5234.17"` would return one member's balance to everybody,
and it would be a value in a repository.

Output types stay `string`. The surface reads text and nothing in replay parses a currency
string into a number, so declaring `number` would be a promise the engine cannot keep. The
demo application renders one member's balance as `$1,024.50` and another's as `118.05`, and
both come back exactly as shown.

## How A Success Condition Is Generated

The condition has to prove the run arrived somewhere, and the run produced the evidence for
that itself: the controls that were on the last screen and not on the first. A heading or a
region is preferred, because that is what an application uses to name the thing it just
showed you, which makes the condition read like the goal rather than like the last button
pressed. A run that ends on the screen it started from has no such evidence, and is a
compilation failure rather than a capability whose success condition cannot fail.

## What The Artifact Cannot Carry

The strict schema is the real protection. There is no free-form metadata object, so there
is no field a prompt, a transcript, a reasoning trace, or a captured form value could live
in; adding one fails validation. The regression test that greps a compiled artifact for
those words is the net under that, not the mechanism.

## What Replay Proved About The Schema

Phase 4 executed the schema without changing it, which was the point of designing it
before there was an engine. Two parts earned their keep immediately. The structured value
model meant parameter resolution is a map lookup rather than a parser, so a reference that
does not resolve is impossible for a validated artifact rather than a runtime surprise.
And the single condition model turned out to serve all four of its jobs through one
evaluator, so a `wait`, a `checkpoint`, a business outcome, and the success condition are
one code path with four callers.

One limit surfaced. A surface extracts text, and an artifact may declare an output as a
`number`, so replay needs a conversion the schema does not describe. It is kept as narrow
as it can be (a canonical numeric literal, or the words true and false) and a value it
cannot read is a failure rather than a guess. A screen showing `$1,024.50` fails today.
The repair is a format declaration on the output definition, which is additive, and it is
deferred because inventing one before a workflow needs it would be guessing at the shape
of the problem.

## Declaring What The Application Says

Phase 5 needed two things the schema could not express, and both were added to the
existing declarations rather than beside them.

`businessOutcomes` gained a `disposition`, defaulting to `businessOutcome`. The list is
still the one list of known application states; most entries are answers and a few, such
as a permission denial, mean the run must stop. A second array for the states that happen
to stop a run would be the same concept written twice, with two places to look when a code
turns up in a result.

`recoveries` is new, and is the smallest thing that makes automatic dismissal safe: a
condition, one control to activate, and an attempt ceiling. It is not a workflow language,
and there is no second action kind until a workflow needs one.

Both are additive with defaults, so every artifact written against the earlier schema
still parses. That is exactly the case `schemaVersion` was designed not to need a bump
for: an older file is readable, and this build's writer simply emits the new fields.

## Safety Metadata

Acting steps carry `risk`: `safe`, `risky`, or `irreversible`, defaulting to `safe`.
Read-only steps do not have the field at all, since giving `extract` a risk level would
only invite a meaningless declaration.

The distinction that matters is that this is a description, never a permission. An
artifact declaring `safe` grants itself nothing; the policy engine stays external and
authoritative, and it is free to refuse a step that claims to be harmless. There is no
capability-level risk field either, because the risk of a capability is derivable from
its steps, and a stated summary is a second source of truth that can disagree with them.

One rule is enforced today: an irreversible step may not declare a retry. Retrying an
irreversible action is how one payment becomes two, and that is a property of the
document, so it is rejected at validation rather than left to the engine to remember.

## Validation

One entry point, three checks in a fixed order, because each only makes sense once the
previous passed.

```text
unknown value
   |
schema version    -> unsupported version fails here, alone
   |
shape (Zod)       -> types, enums, formats, unknown keys
   |
semantics         -> relationships between the parts
   |
CapabilityArtifact
```

Zod stops at the boundary. `ArtifactValidationError` carries `ArtifactIssue[]`, each a
dotted path and a message, translated from Zod issues in one place, so no other layer has
to know which library validated the file and a future change of validator cannot ripple
outwards.

Semantic validation is separate because it asks a different kind of question. Shape
validation asks whether a field is well formed; semantics asks whether the document
contradicts itself:

- step ids, input names, output names, and business outcome codes are unique
- every parameter reference names a declared input
- every extract step assigns a declared output
- no declared input is left unread, and no declared output is left unproduced
- an irreversible step declares no retry
- `metadata.updatedAt` is not earlier than `metadata.createdAt`

The last two rules of the reference group are stricter than they had to be, and they are
there deliberately: an input nothing reads means a caller supplies a value that goes
nowhere, and an output nothing writes means the capability promises a return it cannot
produce. Both are defects that would otherwise surface during a replay, in front of the
application, rather than during review. The whole thing is a flat list of checks over a
parsed artifact; it is a handful of relationships, not a language that needs a compiler.

## Serialization And Storage

Artifacts are reviewed in pull requests, so the written form is indented JSON ending in a
newline, and writing runs the artifact back through the schema first. That gives two
properties: a key order that does not depend on how the object was built, so two
equivalent artifacts produce the same file and a diff shows what changed in the workflow;
and the guarantee that a file which exists is a file that parses.

Storage is a directory. `FileArtifactStore` saves `<id>.json`, loads by id through the
full validation path, and lists summaries sorted by id. No database, no registry service,
no locking: runs are local, artifacts are deliverables meant to be read, and the problems
a registry solves are problems nothing has yet.

Ids never reach the filesystem unchecked. A capability id must be lower-case kebab-case,
which contains no separator, no dot, and nothing a filesystem treats specially, so
traversal is impossible by construction; the store then also verifies the resolved path
is inside its directory, so a future change to the id rule cannot quietly open a way out.
A file whose name and internal id disagree is rejected rather than silently accepted.

## How It Extends Later

Three variations are anticipated by the shape, and none of them is implemented.

**Tenant or vendor specialization.** `application` is a nested object rather than two
loose fields, so a later `tenant` or `vendor` key is an added field, not a redesign. A
capability recorded against one institution's build of a package could then be specialized
without duplicating its steps. What that would need beyond the schema, inheritance,
overlays, a registry to resolve them, is exactly what was not built.

**A second surface.** Targets are the surface-neutral model, so an artifact recorded
against a web surface is already expressed in a vocabulary an accessibility-tree or
desktop surface can attempt. A strategy kind with no meaning on a surface simply never
resolves, which the existing fallback handles.

**A wider vocabulary.** Extraction reads text today; the surface already models `value`
and `attribute`, and adding an optional kind to the extract step is additive. So is a new
step type, a new checkpoint type, and a parameterized navigation URL, which would reuse
the existing value model rather than introduce a template language. None of those needs a
schema version bump, which is what the version is being saved for.

# Determinism & Error Handling

Determinism here is a property of decisions, not of the application. Replay makes none.

The execution plan is `artifact.steps`, read in stored order. Nothing reorders it, skips a
step, substitutes a target, invents a missing step, alters a value, or modifies the
artifact while running it. Each target's strategy order is the recorded order and is never
re-sorted. Every value a step types is either a literal in the file or a named input the
caller supplied. There is no branching construct in the schema, so there is no plan to
compute. The same artifact and the same inputs therefore issue the same operations in the
same order, which `engine.test.ts` asserts by replaying twice and comparing the recorded
surface calls.

## Why Replay Has No LLM Dependency

A model in the decision loop would make every run cost money, take seconds per step, and
produce a different trace each time, and it would make the failure mode "the model chose
differently today", which is not debuggable. The whole value of freezing a discovered
workflow into an artifact is that the artifact is now the decision, made once and
reviewable.

So the rule is structural rather than cultural: nothing under `src/replay/` may import
`src/llm/`, `src/discovery/`, or `@anthropic-ai/*`. It is enforced by a scoped ESLint
`no-restricted-imports` rule and, so that the build fails even if the lint config drifts,
by tests in `tests/architecture.test.ts` that scan the imports. The same tests assert that
replay never imports Playwright, and that the only surface module it imports is the
contract. `browserReplay.test.ts` runs the full chain with no network access at all.

## Parameter Resolution

Two sources, and nothing else: a literal baked into the artifact, or the value of a
declared input. No template syntax, no expression evaluation, no `eval`. A resolver that
could compute would be a decision made at replay time.

Invocation inputs are validated before the surface is touched, so a caller mistake cannot
leave a half-run workflow behind in the application. Unknown inputs are rejected rather
than ignored: a key nobody declared means the caller believes this capability does
something it does not, and ignoring it converts that belief into a silently wrong run.
There is no coercion, because the artifact states the type it wants. An omitted optional
input resolves to the empty string, which clears the field the `fill` targets; Phase 3 has
no default-value model, and failing instead would make `required: false` unusable.

## Checkpoint And Success Verification

This is the part that makes a replay worth trusting. An action that returned without
throwing proves a control was found and operated, not that the workflow reached the state
it was recorded to reach, and those two differ every time an application answers a click
with an error banner.

Every replay evaluates the artifact's required `successCondition`, and a replay whose
success condition fails is never reported as a success even when every step ran. Along the
way `checkpoint` steps assert state and `wait` steps wait for it, through the same four
conditions and the same evaluator. Waiting is state-based throughout: the surface waits on
the state natively, so replay contains no polling loop and no sleep.

Evaluation is not reduced to a boolean. An outcome carries a Title Case rendering of what
was expected next to a bounded rendering of what the surface showed, which is what turns a
failure into something actionable without reproducing the run:

```text
REPLAY_CHECKPOINT_FAILED  step "confirm-lookup-screen"
  expected: Text "Corporate Member Lookup" Is Visible
  observed: Not Visible
```

## Timeouts

The budget hierarchy reuses what the earlier phases already established, with no third set
of numbers invented for replay:

```text
step.execution.timeoutMs  ->  replay-wide override  ->  SurfaceTimeouts from AppConfig
```

The budget is passed to the surface, so a failure is the surface's own specific error, and
it is also enforced from the outside with a deadline. A surface that is wedged, or that
ignores its budget, still cannot make a replay hang. That is worth the duplication: the
inner budget is for good messages, the outer one is a guarantee. How far apart the two sit
is a Phase 5 correction, described under Timeout Classification.

## The Error Taxonomy

Every failure a caller sees carries a stable code that was decided by type, never by
matching the text of a message. Wording is for people and is free to change; a code is a
contract.

The translation happens in two hops, and each makes the failure more domain specific:

```text
Playwright TimeoutError  ->  TargetNotFoundError  ->  REPLAY_TARGET_NOT_FOUND
     (surface adapter)         (surface domain)          (replay result)
```

The first hop is Phase 2 and already existed: `PlaywrightSurface` catches browser
exceptions, keeps the first line of the message, and throws a typed surface error with the
original as its `cause`. The second hop is `src/replay/classification.ts`, and it is the
only module in the engine that knows the surface error types. Nothing else does an
`instanceof` on a failure, so there is one place to change when a surface error is added
and one suite that asserts every surface error maps to something specific.

A caller therefore never needs to understand Playwright, and never receives it either: a
result carries a rendered one-line `cause` with no stack, and a test serializes a real
failure and asserts that no call log, no library name, and no stack frame survives.

The engine's codes are prefixed `REPLAY_`; codes an artifact declares are not. The prefix
answers the first question a reader has about a code: did the engine work this out, or did
the capability declare it? There is exactly one general code, `REPLAY_UNEXPECTED_STATE`,
and it is reachable only by an error that is not a surface error at all. It is not where
unmapped failures land, because there are none.

## Business Outcomes Versus Failures

"No member matches that reference" is an answer. A missing button is a defect. Treating
them alike is what makes an automation page someone at 3am about a member who does not
exist, so a business outcome is a status of its own and carries no `code` from the engine
at all.

The harder question is which of an application's messages are answers. "You do not have
permission to view this member" is a state the application is entitled to show and the
automation is entitled to recognize, but it is not an answer to the question that was
asked, and continuing past it is not something replay may decide to do.

That is declared, not inferred. Phase 3's `businessOutcomes` gained a `disposition`, which
is `businessOutcome` by default and `failure` for a state that must stop the run. The
alternative was an engine that classified by matching page text against a list baked into
it, which is both the wrong place for the knowledge and exactly the thing a stable code
must never be derived from. Only the capability's author knows which of its application's
messages are answers.

The same mechanism answers the validation-message question the assignment raises: an
application's "member id format is invalid" is a business outcome if the artifact declares
it as one, and a failure if it declares it as one. Nothing is categorized by default,
because a validation message means different things in different workflows.

Permission denial and session expiry are both declared as failures in the committed
example. Permission denial, because the automation is not authorized to proceed and a
caller must not treat it as a result. Session expiry, because this capability has no safe
deterministic way to sign in again; when Phase 6 adds escalation, this is the state that
will hand the session to a person rather than a state that changes classification.

Declared states are only looked for after a `wait` or `checkpoint` condition did not hold,
or after the success condition failed. Those are the moments the page has settled and is
saying something. A control that could not be found or operated is an automation problem
whatever the screen says, so the check is skipped there, and a healthy run never evaluates
a declared condition at all.

## Recoverable Conditions

A retry says "try that again". A recovery says "we recognize the state the application is
in, and we know the single control that clears it". The difference is knowledge, and the
knowledge lives in the artifact:

```json
{
  "code": "KNOWN_SESSION_DIALOG",
  "condition": { "type": "targetVisible", "target": { "description": "Session Warning Dialog" } },
  "action": { "type": "dismiss", "target": { "description": "Continue Button" } },
  "maxAttempts": 2
}
```

One action kind, not a workflow language. A recovery names a condition, one control to
activate, and how many times the pair may be applied; replay then retries the step that
failed. Anything richer would be branching, and branching inside an artifact is where
determinism and reviewability both go.

Declaring recoveries is what keeps automatic dismissal safe. An engine that dismissed
whatever dialog it found would eventually approve something, which in the applications
this project is aimed at is not a hypothetical cost. So an interstitial the artifact does
not declare stops the run, and a browser test asserts that the unknown dialog is still on
screen and unapproved afterwards.

Recovery is bounded three ways:

1. **By failure code.** Only failures an interstitial could plausibly cause are eligible:
   a condition that did not hold, a control that could not be found or operated. A missing
   output or an unresolved parameter is not a state a dialog is hiding, and pretending a
   recovery might help would only add a delay before the same failure.
2. **By step risk.** Recovery ends by repeating the step that failed, so it inherits the
   retry rule exactly. Reading and asserting always repeat; an acting step repeats only
   when the artifact calls it `safe`. Clearing a dialog and then re-submitting a request
   that may already have landed is how one transfer becomes two.
3. **By declared attempts.** Each condition may fire only `maxAttempts` times per run,
   capped at three by the schema, counted across the whole run rather than per step.

## Where A Recoverable Condition Ends Up

The assignment asks for four distinctions, and three of them are ways a run can end. A
recoverable condition is not; it is something that happens during one. So a condition that
clears ends as a `success`, and a condition whose recovery runs out ends as a `failure`
with `kind: "recoveryExhausted"`.

Reporting a run as "recoverable" after the engine has already exhausted its recovery would
tell a caller to do the thing the engine just tried. Instead the condition is reported in
two places: every result carries the `recoveries` it performed, so a success that needed
two dismissals is visibly different from one that needed none, and a failure says through
`kind` whether it met a state nothing knows how to clear or a known state that would not
clear. The consequence is a contract an agent can `switch` over with three cases while an
operator reading the same object still sees the whole story.

## Bounded Retries

Only what the artifact declared, capped by Phase 3 at three attempts. A retry repeats the
identical action with the identical target and the identical resolved value: no backoff (a
fixed delay is the clock-based waiting the surface layer exists to avoid), no alternative
target, no fallback action, and certainly no model asked to recover. A retry that changed
what was being attempted would not be replay.

The conservative half is which steps repeat at all, and it is now one predicate shared
with recovery. Reading and asserting always can: `extract`, `wait`, and `checkpoint`
cannot change the application. An acting step repeats only when the artifact calls it
`safe`. A declared retry on a `risky` step is logged and not applied, because a second
submit is how one request becomes two, and Phase 3 already refuses a retry on an
`irreversible` step. The risk model is a description rather than a permission, so replay
reads it in the direction that can only reduce what happens.

## Timeout Classification

Deliberately three codes rather than one per place a clock can run out.

`REPLAY_WAIT_TIMEOUT` means a `wait` step's state never arrived. `REPLAY_CHECKPOINT_FAILED`
means a `checkpoint` step's assertion did not hold, which is not the same thing: Phase 3
drew that line already, and it is the difference between "the page never got there" and
"the page went somewhere else". `REPLAY_STEP_TIMEOUT` means the step as a whole outlived
its budget, and carries `stepType` so the caller knows what it was doing.

There is deliberately no `TARGET_TIMEOUT`. The surface waits for an element and reports
`TargetNotFoundError` whether it was absent or merely late, because it genuinely cannot
tell the two apart, and the remedy is the same either way. A code that can never be
reliably distinguished is worse than not having it. Navigation timeouts arrive as
`REPLAY_NAVIGATION_FAILED` with the surface's own reason in `cause`, which is the
actionable part.

The outer deadline that guarantees a run cannot hang now sits half again above the step
budget rather than a flat second above it. A target with several locator strategies pays a
little overhead per strategy on top of the budget it divides between them, and a bound
that only just cleared the budget turned a surface reporting "the summary never appeared"
into the engine reporting "no response", which is a worse answer to the same question.

## Checkpoint Failure Behaviour

A failed checkpoint keeps what was expected next to what was observed, and that pair is
what makes the result debuggable without reproducing the run:

```text
REPLAY_WAIT_TIMEOUT  step "await-member-summary" (wait)
  expected: Target "Member Summary Region" Is Visible
  observed: Not Visible
```

Classification probes get a quarter of the locator budget rather than all of it. They run
after a step has already failed, which means the page has finished doing whatever it was
going to do; the question is "what is on screen now", not "wait for this to appear".
Charging the full budget made a run that declares several states spend seconds deciding
what to call the failure it already had.

## Policy Denials In The Taxonomy

Phase 6 added one class of outcome to the model rather than a new status. A denial is a
`failure` carrying `kind: "policy"` and a `POLICY_`-prefixed code, which keeps the three
terminal statuses a caller switches over intact while making "the rule stopped this"
machine-readable.

It is deliberately excluded from both interpretive paths. Declared-state detection does not
run, because a guardrail is not an application state to ask the page about; recovery does
not run, because a boundary that a dismissed dialog could clear would not be a boundary.
Policy is also re-evaluated on every retry rather than remembered, since an action being
attempted twice is exactly the situation where a guardrail should be asked twice.

## Bounding A Loop That Contains A Model

Replay is bounded by the artifact it is executing: the steps are known, so the run is
finite by construction. Discovery has no such guarantee, because what happens next is
decided each turn by something that can be confidently wrong. Termination therefore has to
be counted by the application, and none of the limits is visible to the model as something
it could see, raise, or argue with.

Five guards, each answering a different way a run fails to end: a step ceiling, a run
deadline, the same action proposed repeatedly, the screen never changing, and proposed
actions that cannot be carried out at all.

The two loop detectors are worth stating precisely, because both are heuristics.

**Repeated action** fingerprints the normalized action rather than the model's wording, so
two decisions described differently that would operate the same control are recognized as
the same thing. A `fill` contributes a digest of its value rather than the value, which
answers the only question the guard asks (is this the same as last time?) without carrying
somebody's reference into a log. The count is taken before the action runs, so a fourth
identical click is refused rather than performed and then noticed.

**Repeated state** fingerprints the sanitized observation: location, title, and the roles
and names of the controls, with the page text included only as a digest. It recognizes an
identical screen, not a screen that is equivalent in some deeper sense. A page carrying a
clock, a session token in the path, or a rotating advertisement fingerprints differently
every time, so a loop on one will run to the step limit instead. It was still worth having,
because it catches the loop that actually happens, which is an action that changes nothing.

One consequence had to be handled deliberately. An observation carries the controls on a
screen and not the values in them, so `fill` and `extract` leave the fingerprint identical
by design. The loop therefore tells the model that the screen is unchanged only after an
action that should have changed it. Reporting it after a `fill` would be stating a fact
about the observation model as though it were a fact about the application, and in practice
it talked the model out of the correct next step.

## Deadlines Across Two Kinds Of Slowness

A discovery run can hang in two places: inside a model call, and inside a surface action.
Checking elapsed time only between turns would bound neither. Both are wrapped in the same
`withDeadline` guard replay already used, promoted to `src/execution/` when it acquired a
second caller rather than copied, so there is one definition of the outer bound. Each call
is given whatever is left of the run's budget, so a run cannot exceed its deadline by
starting one more long operation just before it expires.

## Normalizing Model Failures

Discovery never sees an SDK exception. Each client maps its provider's failures onto the
same six domain codes by type and status, never by matching message text, because wording
belongs to the provider and a code is something this system promises. The engine then folds
all of them into one result code, `DISCOVERY_MODEL_UNAVAILABLE`, with `kind: 'provider'`,
which is the distinction a caller actually acts on: the model layer failed rather than the
workflow.

Message text is fixed per code rather than taken from the exception. A provider error can
quote the request it failed on, and a request carries an authorization header. The original
stays on `cause` for a debugger and is never rendered into anything printed or persisted.

Retries are deliberately meagre. The Anthropic client allows one SDK-level retry for
failures it already treats as transient. The loop allows one re-ask per turn, and only when
the answer failed validation rather than the provider failing, because a small model that
returned a nearly-right object usually returns a right one when told which field was wrong.
A second invalid answer ends the run, so a model that cannot produce a decision cannot burn
a budget proving it.

## Why Constrained Decoding Is Not Trust

A provider able to constrain its decoding to a JSON Schema is given one, generated from the
same Zod schema that validates the answer so the grammar and the validator cannot disagree.
This was not a nicety: without it, an 8B local model reliably produced plausible JSON with
the fields in the wrong places, and the run died on validation rather than on anything
about the application.

It constrains shape and nothing else. A grammar cannot stop a model naming a control that
is not on screen or claiming a balance the page never showed, so the answer is still parsed
and still validated, and the schema remains the only thing that can produce a decision. A
provider that ignores the field behaves exactly as before.

## Verifying A Claimed Completion

A model saying it is done is a claim about the world, and the world is available to check
it against. Before a run is called successful, at least one action must have been carried
out, and every value the model reports must be one the application actually showed: either
extracted by the surface or visible in the final observation. The comparison drops currency
symbols and separators, so a screen showing `5234.17` supports a reported `$5,234.17`
without making two different balances equal.

The gap is honest and documented: a goal that reads nothing and changes nothing is accepted
on the strength of the summary plus the fact that work happened, because there is no
goal-specific condition to check it against until Phase 8 compiles one.

## Why Verification Gates Persistence

A compiled artifact is a hypothesis. It is well-formed, it validates, and none of that says
the workflow runs. So a capability is saved only after the real replay engine has executed
it against the live application through the real policy engine, with the values discovery
used. There is no easier verification path, because the question is whether the artifact
works the way production replay will run it.

The order matters as much as the check. Compile, validate, replay, then save. The
alternative, save and then verify and maybe delete, puts an unproven capability in the store
for a window during which something could invoke it, and leaves a broken one behind whenever
the delete is the step that fails.

Verification asks two questions, and the second one was added because the first is not
enough. A replay that succeeds proves the workflow ran. It does not prove the capability
reads the right thing: an extract step can resolve, return text, and satisfy every
condition while addressing the heading above a balance rather than the balance. That
capability replays perfectly and answers the wrong question. The discovery run already
checked its own reported values against what the application was showing, so those are the
reference, and a mismatch is a rejection. Only the output names appear in the message,
never the values.

Finding that case is what produced the one surface change in this phase. A printed balance
has no role and no accessible name, so an accessibility snapshot cannot describe it and a
workflow that reads one could be discovered but not written down. The observation now also
lists the elements carrying a stable attribute such as `data-field`, by attribute and value
and never by content, which gives such a value something a locator can hold on to.

## What Is Deferred

To Phase 9:

- **Escalation and handoff.** Replay classifies and stops. Nothing yet decides that a
  session should be handed to a person, which is what `SESSION_EXPIRED` is waiting for.
- **The policy engine.** Retry and recovery safety are read from the artifact's own `risk`
  description, which is a description and not a permission. Policy should be the authority
  on whether a step may be repeated, not the document that describes it.
- **Evidence.** Runs emit structured events (`Recoverable Condition Detected`, `Recovery
Attempt Started`, `Recovery Exhausted`, `Hard Failure Classified`), but nothing is
  persisted, no screenshot is captured on failure, and there is no redaction layer beyond
  the logger's own.

Later, and out of scope on purpose:

- **A bounded LLM fallback for recovery.** The assignment names it a stretch goal. It is
  not implemented, and the architecture test now asserts that the recovery path in
  particular imports no model layer, because that is where such a thing would first
  appear.
- **Richer recovery actions.** One kind, `dismiss`, covers both states the fixture can
  demonstrate. A second kind should arrive with a workflow that needs it, not before.

# Heterogeneity & Multi-Tenant

Multi-tenancy remains out of scope: there is no tenancy plumbing, no database, and no
queues. What Phase 3 added is the room for it, at the cost of one nested object.

Compilation strengthens the reuse story without adding any of that. A compiled capability
names no model, no provider, and no browser: it is targets, values, conditions, and step
types, all of them surface-neutral by construction, and an architecture test refuses a
Playwright or SDK import in the module that produces it. So the artifact a run against a
Chromium page produces is expressed in terms a different surface implementation could
resolve, and the deployment that replays it needs neither an account nor a credential.

The same property is what a future tenant variant would build on. Two tenants running
different builds of the same application differ in their locators and their entry point,
both of which live in the artifact rather than in the engine, so the variation is data. It
is not implemented, and nothing here pretends otherwise.

Heterogeneous surfaces are handled by the surface contract, as before: an artifact stores
surface-neutral targets, so a workflow recorded through one surface is expressed in a
vocabulary another can attempt, and a strategy kind that means nothing on a given surface
simply never resolves.

For institutions, a capability names its `application` as an object:

```json
{ "application": { "name": "Demo Support Console", "entryPoint": "https://demo.replay-ai.test" } }
```

Adding a `tenant` or `vendor` key there later is an added field rather than a redesign,
and the capability version already exists to distinguish revisions of one workflow. That
is the whole extent of the preparation, and it is deliberate. The real work of
multi-tenancy is not the schema: it is inheritance of a base capability by a tenant
overlay, resolution order between them, a registry to look them up in, and isolation of
credentials and evidence per tenant. Half-building that would produce plumbing with no
users and a schema shaped around guesses about how overlays should merge. It was left
out, and the artifact was kept extensible enough that leaving it out costs nothing later.

# Escalation & Handoff

`src/handoff/` is still empty: nothing pauses a session or hands one to a person. What
Phase 7 added is the thing Phase 9 will build on, which is a run that can say it needs one.

## Escalation Is A Result, Not An Exception

`DiscoveryEscalation` is a third arm of the result union beside success and failure, rather
than an error. A run that needs a person has not gone wrong: the session is still open, the
trace is still valid, and the only thing missing is a decision nobody automated. Modelling
it as a failure would put it in the same bucket as a broken locator and lose exactly the
distinction an operator needs.

Two things produce one, and the result says which:

- **The model asked.** It returned `{"type":"escalate","reason":"…"}` because the
  application wanted a permission, a payment, a confirmation of something irreversible, or
  a credential it was not given.
- **Policy required approval.** The guardrail answered `confirmationRequired`, which today
  means no, because there is nobody to ask. The action is not performed.

The escalation carries the run id, the reason, the step count, the last action, and the
whole trace, which is the material a person would need in order to take over.

## Why Phase 9 Does Not Need A Redesign

The Phase 2 decision to keep the browser session outside the surface is what makes a live
handoff possible: no automation object believes it owns the session lifetime, so the page
the run was using can be given to a person and taken back. Discovery inherits that, because
it drives a `ComputerSurface` it did not create and does not close.

What is missing is only the mechanism: somewhere to send the request, a way for a person to
answer, and a resumption path. None of that changes the shape of the result, which is why
it was worth defining the result now.

## The Model Cannot Escalate Its Way Around A Rule

An escalation is a request for a person, never a way past the guardrail. A model that
escalates gets a stopped run, not a retried action. The reverse also holds: policy denying
an action is not something the model can appeal by escalating, because the run has already
ended by then.

# Safety

The two halves of this section are the guardrail that decides what may happen and the
record of what did. Both landed in Phase 6.

## External Policy Authority

The automation never decides its own permissions. A capability artifact is written by
whoever recorded a workflow; the policy is written by whoever operates it, and only the
second is authoritative:

```text
Capability Says:  "This Action Is Risky"
Policy Says:      "Risky Actions Require Confirmation"
                = Confirmation Required, And Nothing Happens
```

There is deliberately no path in the other direction. An artifact declaring `safe` gains
nothing it would not have had by saying nothing, and a deployment that refuses `safe` work
refuses it whatever any artifact claims. Both are asserted directly, because "the artifact
cannot grant itself permission" is the kind of property that is true until somebody adds a
convenient shortcut.

`ReplayEngine` requires a policy. There is no constructor option that turns the guardrail
off, because a component with an optional guardrail has a mode with none, and that is the
mode that ships by accident. Tests that are about something else pass an explicitly
permissive policy rather than no policy: permissiveness is a configuration, not an absence.

## Deny By Default

Out of the box the policy reaches nothing, over `https` only, asks before anything risky,
and refuses anything irreversible. An unlisted host, an unrecognized action type, an
unrecognized risk level, an unsupported scheme, and a URL that will not parse are all
refusals rather than gaps. An empty allowlist means nothing is reachable, not everything.

The cost is a first-run experience where `npm run replay` refuses until a policy is
written. That is the correct cost: an allowlist nobody filled in is not permission to go
everywhere, and `.env.example` ships the local development policy so writing one takes a
copy.

## Domains, Schemes, And Routes

Every check works on a parsed `URL`. Nothing compares substrings, because
`url.includes('localhost')` is satisfied by `https://localhost.attacker.example`, and an
allowlist a subdomain defeats is not an allowlist. Hostnames are lower-cased and the
trailing dot a resolver ignores is ignored here too. There are no wildcards: `*.example.com`
reads as a convenience and is how an allowlist ends up covering a subdomain somebody else
controls.

`localhost`, `127.0.0.1`, and `[::1]` stay distinct. They are one machine and three names,
and quietly treating one entry as permission for the others is a hole nobody wrote down.
A deployment that means the loopback interface lists the forms it uses.

Route prefixes match on segment boundaries, so `/members` covers `/members/42` and not
`/membersecret`. They are optional on a host that is already allowlisted, which is a
deliberate exception to deny-by-default: the host is the control that matters, and forcing
every deployment to enumerate routes pushes people towards writing `/` and stopping
thinking. A scheme with no host has no such control, so `file:` requires the route list
and an empty one refuses everything.

Redirects are re-checked once. A permitted destination that answers with a redirect
somewhere else stops the run, which is bounded and testable, rather than a redirect
monitor with its own failure modes.

## Risk Classification

Risk comes from the Phase 3 artifact metadata, and nothing infers it from button text.
`safe` runs, `risky` requires confirmation, `irreversible` is refused. Every one of those
mappings is configuration, so a deployment may refuse `risky` outright or, knowing what it
is doing, allow it.

Confirmation required means the run stops with `POLICY_RISK_CONFIRMATION_REQUIRED` and the
action does not happen. There is no approval queue and no simulated approval, because a
person cannot be asked yet and pretending otherwise would be the most dangerous kind of
placeholder. Phase 9 turns this into a real control transfer.

A policy denial is a `failure` with `kind: "policy"`, which is how a caller distinguishes
"the automation could not do this" from "the automation was not permitted to do this".
Those are different incidents: one is a defect, the other is the system working. A denial
is also never sent down the paths that ask the page what it meant or try to clear an
obstacle, because a guardrail a dialog can clear is not a guardrail.

## What Is Written Down

Evidence is a durable, sanitized record of one run, deliberately not a copy of the
developer log. A log is a stream someone watches; evidence answers what ran, what it was
allowed to do, what happened, and where it stopped, for someone who was not there.

Redaction rules live in `src/redaction.ts` and are shared with the logger. That sharing is
the point rather than tidiness: a secret scrubbed from a durable record and printed to a
terminal that gets pasted into a ticket has not been scrubbed.

Never persisted: invocation values (only input names reach evidence, and the value a
`fill` typed appears nowhere), credentials, tokens, cookies, authorization headers, API
keys, session identifiers, and stack traces.

URL query values are removed wholesale rather than matched against a list of suspicious
parameter names. A denylist catches `?token=` and misses `?acct=`, and in the applications
this project targets the second is the one that matters. Parameter names survive so the
shape of a request stays visible. Fragments are dropped entirely, and credentials embedded
in a URL with them.

Every policy decision is recorded, not only the refusals, because a record listing only
refusals cannot tell a permitted action from an unchecked one.

## Screenshot Limitations

One screenshot per run, at the failure that ended it, named from the failure code so a
directory listing cannot leak what a run was looking up.

**A screenshot is a picture of the application and may contain whatever it was
displaying.** There is no visual redaction and none is claimed. The fixture uses synthetic
data; a production deployment would need stronger screenshot handling, a policy of not
capturing at all on certain screens, or both. Fabricating an image-redaction capability
would be worse than the honest limitation.

The same reasoning shaped a smaller decision: a checkpoint's observed text is recorded only
when the checkpoint failed. On a pass it adds nothing an operator needs and everything the
page happened to be displaying.

## Evidence Failure Policy

A run's result never changes because evidence could not be written. An event or a
screenshot that fails becomes a warning on the manifest, so the loss is visible without
being fatal. A manifest that cannot be written throws, because a run directory that exists
and says nothing about the run is an observability failure worth hearing about rather than
burying. The manifest is written through a temporary file and a rename, so a reader never
finds half a JSON document; that is one extra call, not a transaction system.

## The Guardrail Applies To The Model

Phase 6 built the policy engine so that a stored step and a model-proposed action would
describe themselves identically and be judged by the same code. Phase 7 is where that paid
off: discovery calls the same `evaluate` with the same `PolicyContext`, and there is no
discovery-specific policy, no second allowlist, and no path to the surface that skips it.
The opening navigation to the target is checked too.

Two details carry the weight.

The declared risk handed to policy is **derived from the action**, never taken from the
model. A model able to label its own action would be a model able to argue itself past a
guardrail. It is set to `safe`, which is what an artifact step of the same type declares by
default, so an action is judged the same way during discovery as it will be during replay.
The two controls that actually matter for discovery do not depend on risk at all: the
deployment says which action types it permits and which destinations may be reached.

A model asserting safety has no standing. `"This action is safe"` is a sentence in a
summary field bounded to 200 characters; the deployment's configuration is the authority. A
test drives exactly that case, proposing a forbidden action with a reassuring summary, and
asserts the surface was never called.

## What A Discovery Run Writes Down

Discovery writes the same sanitized evidence a replay does, and the interesting part is
what it cannot write.

`DiscoveryJournal` is the only way an event reaches the record, and it has no method that
accepts a prompt, a transcript, a provider response, or an observation. A decision is
recorded as its type, the action it names, and the bounded summary the schema already
validated. There is therefore no call site, present or future, that could persist a raw
provider body, which is a stronger guarantee than a policy saying not to.

Specifically absent, each for its own reason:

- **Reasoning.** Never requested, never read at the provider boundary, and with no field in
  `ModelResponse` able to hold it. A model that emits reasoning beside its answer has that
  content dropped before anything else in the system sees it.
- **The prompt.** It contains the goal and the current screen. The record keeps the fact
  that a request happened, its attempt number, and its budget.
- **Fill values.** A model reference, a customer number, a search term. The trace keeps them
  because Phase 8 needs them to decide what becomes a capability input, which is exactly why
  a trace stays in memory and is never serialized or printed.
- **Extracted values.** Only the output names are recorded. The values are the caller's
  answer, returned to them, not written into a file that outlives the run.
- **Observation text.** Recorded as a length and a fingerprint. A balance on screen is not
  copied into evidence.

Token counts are recorded as `inputSize` and `outputSize` rather than with the word "token"
in the field name, because the shared redaction rule replaces any field whose name looks
credential-bearing and a count is not one. Renaming the field was the right fix; loosening
the rule was not.

## A Generated Capability Grants Itself Nothing

A capability that came out of a successful discovery run has earned no privileges. Its
verification replay is evaluated by the same policy engine, asked the same questions, and
refused on the same terms as any other run. A test drives exactly that: under a read-only
policy the compiled workflow is rejected and the fill never reaches the surface.

The `risk` the compiler writes is a description, derived from the step type rather than
taken from anything the model said. Policy decides what happens to a step at that risk, and
an artifact declaring `safe` gains nothing it would not have had by staying silent.

## Sensitive Values Become Parameters

The reason parameterization is a safety property and not only a reuse one: the value that
would otherwise be baked into a committed file is a member reference, a customer number, or
worse. Compilation lifts it out by name, so the artifact carries `memberId` and the value
travels per invocation. An input declared sensitive is marked as such in the artifact, which
is the declaration the logging and evidence layers already act on.

The artifact is checked for this directly. A compiled capability is asserted not to contain
the value discovery typed, nor the value discovery read, nor any of the words a provider
transcript would arrive under.

## Two Kinds Of Test, And Why Neither Needs A Key

The whole automated suite mocks the `LLMClient` boundary and nothing below it. The policy
engine, the surface contract, the loop guards, and the evidence recorder are all real, so a
test asserting that a blocked action never reached the surface is an assertion about the
real guardrail rather than about a stub that agreed with it.

The live path is separate and is run by hand against the controlled demo application. CI
never spends a credit, and nothing in the repository requires a provider to be configured.
That split is deliberate: the assignment needs evidence from a genuine model-driven run,
and there is no reason to pay for one on every pull request.

## What Came Before

The credential handling from earlier phases, which is the part a public repository has to
get right immediately:

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

Phase 3 adds the artifact half of that. An artifact is a file that gets committed, so
the design question is what could ever end up in one:

- the schema rejects unknown keys everywhere, so there is no field a prompt, a transcript,
  a cookie, or a captured form value could be written into, and no free-form metadata bag
- values that vary per invocation are declared inputs, resolved at replay time, and never
  stored; the only values in the file are literals an author wrote deliberately
- an input can be marked `sensitive`, which is the declaration that the value it will
  carry must never reach a log, an evidence file, or an error message
- target descriptions are documented as labels for logs, never a value a user typed
- capability ids are validated before they touch the filesystem, and the store checks the
  resolved path is inside its directory, so an artifact cannot cause a write elsewhere

The risk levels (`safe`, `risky`, `irreversible`) are a description and not a permission.
That distinction is the point: an artifact declaring itself safe grants nothing, and the
policy engine that will read it stays external and authoritative. The one safety rule
enforced in validation is a property of the document: an irreversible step may not declare
a retry.

Phase 4 adds the execution half, and reads the risk field only in the direction that can
reduce what happens. A step is repeated automatically only when it cannot change the
application, or when the artifact calls it `safe`; a declared retry on a `risky` step is
logged and dropped. Nothing in replay treats `safe` as authority to do anything. Beyond
that, invocation values never reach a log or a result, only input names; a raw browser
exception never reaches a caller; and a failure message never echoes a value it rejected,
because an invalid value can still be a secret.

Still to come:

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
- **No inferred business outcomes.** The compiler carries through the declared application
  states it is given and invents none. Only the person recording a capability knows which of
  an application's messages are answers and which are failures, and a compiler that guessed
  would be deriving a stable code by matching page text, which is the one thing a code must
  never come from. A generated capability therefore starts with none, and an unknown member
  is a hard failure until somebody declares that outcome.
- **No capability version history.** A newly compiled capability is version 1. An id that is
  already taken is refused unless `--overwrite` is passed. Version bumping, diffing a
  re-recorded workflow against its predecessor, and migrating callers are all real problems
  and none of them is this phase's.
- **No second-input verification.** The verification replay uses the values discovery used,
  which is what proves the run was converted faithfully. Reuse with a different input is
  demonstrated by the end-to-end test and by hand rather than required before saving, since
  a capability whose second input the fixture cannot supply would be unsavable for a reason
  that has nothing to do with the workflow.
- **No human handoff.** A run that needs a person returns a structured escalation and stops.
  Nothing pauses, holds, or transfers a session.
- **No screenshots during discovery.** The observation is text and structure. An image per
  turn would multiply the cost of a run for information the accessibility tree already
  carries on a web surface, and the recorder can still capture one when a surface without a
  clean DOM makes it necessary.
- **No token-budgeting subsystem.** Cost is controlled by a compact observation, a bounded
  five-step history, no transcript growth, and a small output ceiling. Anything more would
  be machinery in place of restraint.
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

Artifact-schema cuts:

- **No template language.** Values are structured references, not `{{ inputs.x }}`
  strings. A template needs a parser, fails at replay time instead of review time, and
  cannot be checked against the declared inputs without one.
- **No rich input types.** `string`, `number`, `boolean`. Enums, arrays, objects, unions,
  and dates each need a resolution rule in replay that nothing requires yet, and every one
  of them is additive later.
- **No parameterized navigation URL.** No workflow needs one, and a caller-supplied
  destination is a policy question rather than a schema question. If it arrives it reuses
  the existing value model.
- **No extraction kinds.** Text only, though the surface already models `value` and
  `attribute`. An optional kind on the extract step is an additive change when a workflow
  needs one.
- **No conditional or looping steps.** Branching inside an artifact is where determinism
  and reviewability both go. A workflow whose shape depends on what it finds is a
  discovery problem, not a step type.
- **No capability-level risk summary.** Derivable from the steps, and a stated summary is
  a second source of truth that can disagree with them.
- **No backoff framework.** Attempts capped at three, no curve, no jitter, no
  per-error-class policy. Operational tuning belongs to the engine, not to a document
  committed once and read for months.
- **No recovery language.** A recovery is a condition, one control, and a ceiling. A
  sequence of corrective steps, a conditional, or a nested workflow would each be
  branching inside an artifact, which is where determinism and reviewability both go.
- **No artifact CLI command.** Validation and storage are a library API; a command belongs
  with the discovery command that will use it. `replay-ai replay` loads an artifact by path
  or by id already.

Replay-layer cuts:

- **No AI recovery, fuzzy matching, or fallback action.** A retry repeats the identical
  operation or the run stops. Anything else would be a decision made at replay time, which
  is the one thing the architecture forbids.
- **No polling loop and no sleep.** State-based waiting belongs to the surface, which is
  why `waitFor` was added to the contract rather than built out of `observe` in replay.
- **No shared execution layer yet.** `src/execution/` stays empty: with one caller, a
  shared waist is an abstraction with nothing on the other side of it.
- **No parallel or branching execution.** Steps are a list, executed in order. A workflow
  whose shape depends on what it finds is a discovery problem.
- **No output format declarations.** A `number` output must be a canonical numeric
  literal; `$1,024.50` fails rather than being guessed at. The repair is an additive field
  on the output definition, and inventing it before a workflow needs it would be guessing
  at the shape of the problem.
- **No evidence persistence or screenshot on failure.** Runs emit structured log events
  only. A half-built evidence layer would duplicate work Phase 6 is scoped to do with
  redaction included.
- **No CLI framework.** Argument parsing is about sixty lines of `switch`. A dependency
  would be larger than the thing it replaced.

Error-handling cuts:

- **No fourth terminal status.** A recoverable condition is something that happens during
  a run rather than a way one ends, so it is reported as recovery history plus a failure
  `kind`. A `status: "recoverable"` would tell a caller to attempt what the engine already
  attempted.
- **No error class hierarchy.** One classification function and a flat code list. A tree
  of exception types would need a visitor to be useful and a decision at every new leaf.
- **No `TARGET_TIMEOUT`.** The surface cannot tell an absent element from a late one, and
  a code that can never be reliably distinguished is worse than not having it.
- **No string matching on exception text.** Classification is by error type only. Message
  wording is for people, and a contract derived from it breaks on a library upgrade.
- **No automatic dismissal of anything undeclared.** An engine that cleared whatever
  dialog it found would eventually approve something.
- **No LLM recovery fallback.** Named a stretch goal by the assignment, and left out: an
  AI decision inside replay is the one thing the whole architecture is arranged to
  prevent.

Safety and evidence cuts:

- **No policy DSL.** Lists of hosts, schemes, routes, and actions, plus three risk
  dispositions. A rule language would need a parser, a test suite of its own, and a
  reviewer who understands it, to express rules nobody has yet needed.
- **No wildcard hosts.** `*.example.com` reads as a convenience and is how an allowlist
  ends up covering a subdomain somebody else controls.
- **No approval queue.** `confirmationRequired` stops the run. Simulating an approval
  nobody gave would be the most dangerous placeholder in the system.
- **No visual redaction.** Screenshots are treated as sensitive and documented as such
  rather than passed through an image filter this project has not built.
- **No remote or database evidence.** A directory per run, because a run record is
  something a person reads, diffs, and attaches to a ticket.
- **No retention policy.** Evidence is never deleted automatically. Retention is an
  operational decision, and a phase that quietly deleted records would be the wrong place
  to make it.
- **No redirect monitor.** One re-check after navigation, which is bounded and testable,
  rather than a watcher with its own failure modes.

Cuts made in later phases will be recorded here as they happen.
