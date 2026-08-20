# Architecture

Replay AI splits discovery from replay. A model works a workflow out once; replay never
uses one.

The CLI is the composition root. `discover` builds an Ollama `LLMClient`, a
`StaticPolicyEngine`, a `FileEvidenceRecorder`, and a Playwright session for
`DiscoveryEngine`; `replay` builds a surface and a recorder for `ReplayEngine`. Neither
engine imports Playwright or a model runtime, so a second surface or model client is a
change to the CLI and to nothing above it.

`DiscoveryEngine` is the only component with a model in its decision loop. It observes the
page through `ComputerSurface`, asks `LLMClient` for one structured decision, validates it,
asks `PolicyEngine` whether the action may run, then acts. A successful run produces a
`DiscoveryTrace`, not a capability. `ArtifactCompiler` turns that trace into a
`CapabilityArtifact`, validates it, and verifies it by replaying it. Only a verified
artifact reaches the store.

`ReplayEngine` executes a saved artifact against `ComputerSurface`, `PolicyEngine`, and
evidence, with no dependency on `llm/`, `discovery/`, `compilation/`, Ollama, or
Playwright. Recovery is declared in the artifact and executed by deterministic code.
`PolicyEngine` is the authority both loops share, because an artifact describes a workflow
and cannot authorize itself. `AutomationSession` owns who may act in a live browser:
automation, or a person, never both.

The rules that carry the weight, enforced by ESLint and `tests/architecture.test.ts`:
replay never reaches a model; discovery never reaches Playwright; artifacts never reach
discovery, replay, or a model; compilation never asks a model. The committed runs are
listed in [`evidence/README.md`](evidence/README.md), and the capability they produced is
`capabilities/search-restaurants-by-cuisine.json`.

# Artifact Schema

A capability is a versioned JSON document. `schemaVersion` is the shape the repository
understands; `version` is the revision of that particular capability. They are independent
so a schema migration does not look like a new workflow.

Inputs and outputs are typed (`string`, `number`, `boolean`), and required inputs must be
supplied at invocation. Sensitive inputs are treated as secrets: not logged, not written to
evidence, not baked into steps. A fill value that matched a declared discovery input
compiles to `{ "source": "input", "name": "cuisine" }` rather than a literal, which is how
one search for Japanese restaurants becomes a reusable cuisine search. The value read
during discovery is deliberately not stored: an artifact holding `1 result for "Japanese"`
would return one search's answer to every future caller.

Steps are a discriminated union: `navigate`, `click`, `fill`, `extract`, `wait`,
`checkpoint`. Each carries an id, a risk level, and the data that step type needs. Locator
strategies live on a `target` (role, label, placeholder, attribute, text, css, in that
preference order), the same target model the surface uses, so an artifact is not a
Playwright script. Checkpoints and the success condition are explicit observable states,
not "the last click returned". Business outcomes are declared answers the application may
give instead of success. Risk metadata (`safe`, `risky`, `irreversible`) is advisory;
policy still decides. Nothing else is in the file: no prompt, transcript, reasoning, API
key, Playwright object, or discovery trace.

The schema also has to be reviewable, because compilation stops short of what one
happy-path run cannot know. A run that found restaurants never saw an empty result, so it
cannot know that "No Restaurants Found" is an answer rather than a fault, and it proposes
locators from the one screen it saw. Version 1 of the committed capability is exactly what
the compiler produced. Version 2 is that artifact after a person declared the business
outcome and generalized the locator, re-verified by replay. `version` moving while
`schemaVersion` holds is the record of that review.

# Determinism & Error Handling

Replay executes steps in the stored order. Parameters resolve before a step runs: a missing
or mistyped input fails closed with `REPLAY_INPUTS_INVALID`, a reference naming no input
with `REPLAY_PARAMETER_UNRESOLVED`. Checkpoints are evaluated against the live page, and so
is the success condition after the last step, so a run cannot report success because a
button was clicked. If it does not hold, the result is `REPLAY_SUCCESS_CONDITION_FAILED`.

Declared business outcomes are terminal answers rather than failures: `NO_RESTAURANTS_FOUND`
with exit status 2, or `MEMBER_NOT_FOUND`, codes the capability owns and not ones the engine
knows. They are evaluated only when a condition fails, never speculatively, so classification
happens where the workflow is already stuck. Recoverable conditions are the opposite
declaration, a known dialog the artifact knows how to dismiss: the engine retries a bounded
number of times, and if it clears, the original step is retried and the run still ends as
success with the recovery recorded. If it does not, the result is
`REPLAY_RECOVERY_EXHAUSTED`. A state nothing declares is a hard failure with a step id, a
code, and evidence, not a stack trace.

Timeouts are per action, per wait, and per step, and retries are bounded and only for what
the artifact named. Replay never asks a model what to do about a failure. Discovery has its
own mechanical loop guards (max steps, wall clock, repeated action, repeated state, dead
end), because a model in a loop will otherwise not stop. Model failures map onto a small
taxonomy (`MODEL_TIMEOUT`, `MODEL_UNAVAILABLE`); the client never returns a raw body, and
reasoning fields are not read.

UI drift surfaces as a checkpoint or success condition that no longer holds, reported with
what was expected and what was observed rather than as a quiet pass. Generic locators absorb
some of it, which is why review generalized the result count target away from the literal
text discovery saw. The rest is a re-discovery, producing a new artifact version and a
review, not a model improvising mid-replay.

# Heterogeneity & Multi-Tenant

Nothing here is a desktop surface, an accessibility-native driver, or a multi-tenant
runtime. The seams that would extend there are the ones the vertical slice already uses.

`ComputerSurface` is how every engine talks to an application, and Playwright is today's
only adapter. A desktop adapter would implement the same observe / act / wait contract, and
discovery, compilation, and replay would not change. Locator strategies are already generic
(role, label, text) rather than CSS-only, which is what an accessibility tree or a desktop
automation API would also supply.

A capability artifact is versioned, validated, and independent of how it was authored. Two
institutions running the same vendor product can share a capability id and differ on policy,
entry URL, and invocation inputs, because policy is already external: hosts, schemes,
routes, actions, and risk dispositions are deployment configuration, not fields an artifact
can set. That is the multi-tenant seam. What is not built is the runtime hosting many such
deployments: no tenant registry, no per-tenant secret store, no isolated browser pools.

# Escalation & Handoff

An intervention is raised when replay meets a state it cannot clear, when policy requires
confirmation, or when discovery itself asks for a person. The coordinator pauses automation,
marks the `AutomationSession` as under human control, and opens a local operator page. There
is one owner: automation cannot act while a person holds the session, and a person cannot
act as automation.

The person works in the same Playwright page, with the same context, cookies, and
half-filled form. What they do is recorded as evidence that a person acted, not as forged
automation steps. On resume, replay re-observes the page and continues only if the expected
state now holds; discovery, if it was the caller, takes a fresh observation rather than
trusting the pre-pause one.

The operator UI is a local unauthenticated page for someone sitting at the machine, not a
production console. Policy still applies to automation after resume: handing control to a
person is not a way around the allowlist. Handoff is demonstrated against the controlled
local fixture, never against production SeatPing.

# Safety

Policy is deny-by-default. An empty host allowlist reaches nowhere. Schemes default to
https. Actions default to the artifact vocabulary and can be narrowed to read-only. Routes,
when set, match on path-segment boundaries. Risk dispositions default to allow, require
confirmation, and block, for safe, risky, and irreversible.

The check runs before `ComputerSurface` is invoked, in discovery and in replay, so a blocked
action never reaches the browser. Discovery re-checks the URL after an action, because a
click can navigate somewhere the original action's URL was not. Confirmation-required
actions pause for a person; irreversible actions are blocked. Redaction is shared by the
logger and the evidence recorder: fill values, API keys, tokens, cookies, authorization
headers, and query-string values are not persisted, and raw model responses and
chain-of-thought are not persisted because the client never returns them.

Two limits worth naming. URL path segments survive redaction, because a path is what makes
an evidence line worth reading, so an application that puts an identifier in the path
(`/members/12345`) writes it into evidence, and a deployment handling regulated data would
narrow this rather than rely on it. And redaction is a denylist of shapes and names: it
removes what it recognizes, and cannot promise that an application will not print something
sensitive into a heading that an observation then summarizes. There is also no visual PII
redaction, so screenshots are of public or synthetic pages only.

The SeatPing demo is public restaurant search. It does not log in, join a queue, create a
reservation, or handle credentials.

# Cuts

These were left out on purpose.

**Desktop automation.** A second `ComputerSurface` adapter. Next: implement the contract
against an accessibility or desktop API and replay the same artifacts unchanged.

**Privileged integrations.** A local fixture and a public search are the slice. Next: a
deployment with a tight host allowlist and irreversible actions blocked, pointed at an
application the operator actually owns.

**Operator authentication, remote browser streaming, and a persistent session registry.**
The handoff page is local and unauthenticated, and sessions live in one process for the
length of a run. Next: bind the operator UI to an audit identity, and add a registry that
can reconnect a paused session, still with one owner.

**Distributed execution, multi-tenant runtime, remote artifact storage, approval workflows.**
Next: keep artifacts and policy as they are, and put a control plane around them rather than
inside them.

**AI replay recovery and learning from human intervention.** Replay stays deterministic.
Next: compile a new capability from a corrected trace, rather than asking a model mid-replay
what to click.

**Coordinate targeting and generated code.** Observations are accessibility-tree based, and
artifacts are data rather than scripts.

**Declared recoveries and injected failures against SeatPing.** The live capability declares
a business outcome because SeatPing genuinely answers "No Restaurants Found", and declares no
recovery because the site shows no interstitial worth clearing; inventing one would declare a
state the application does not have. Nor is a healthy public service broken on demand so the
wreckage can be committed. Recoveries, a declared failure state, a missing required input, a
host outside the allowlist, a read-only deployment refusing a write, and an undeclared state
are all exercised against the local fixture in `tests/e2e/replay.spec.ts`.
