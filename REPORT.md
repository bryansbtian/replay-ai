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

## What Is Deferred

To Phase 6:

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

Placeholder. `src/handoff/` is empty by design. Replay reports an outcome and stops;
nothing yet decides that a person should take a session over. The Phase 2 decision to keep
the browser session outside the surface is what will make that possible without a redesign,
because no automation object believes it owns the session lifetime.

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

Cuts made in later phases will be recorded here as they happen.
