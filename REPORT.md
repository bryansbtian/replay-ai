# Architecture

Placeholder for Phase 1. The shipped foundation is described in
[README.md](README.md#architecture): a pipeline where discovery and replay are two ways
of choosing the next action, both applying it through one shared execution layer, with
`replay/` structurally forbidden from importing `llm/`.

This section will eventually document:

- the module boundaries and why the dependency direction runs the way it does
- the shared action vocabulary that lets a discovered run be replayed unchanged
- how surfaces are abstracted so a second surface does not disturb execution
- where state lives during a run, and what is intentionally kept stateless

No further design decisions are recorded here yet, because none have been made beyond
the boundaries the repository already enforces.

# Artifact Schema

Placeholder for Phase 2. Nothing is implemented, so nothing is specified here yet.

This section will eventually document:

- the typed, versioned capability artifact and the Zod schema it is parsed with
- how a step records intent, target, and expectation rather than raw coordinates
- parameterization: which values are inputs supplied at replay time instead of baked in
- versioning and compatibility rules for artifacts written by older discovery runs
- the guarantee that artifacts never contain credentials or personal data

# Determinism & Error Handling

Placeholder for Phase 3. What exists today is the constraint, not the mechanism: no LLM
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

Placeholder. Multi-tenancy is explicitly out of scope for this project, and Phase 1 adds
no tenancy plumbing, no database, and no queues.

This section will eventually document:

- how heterogeneous surfaces are handled behind one surface interface
- what would change to make a run tenant-scoped, and what deliberately was not built
- why per-tenant isolation was cut rather than half-built

# Escalation & Handoff

Placeholder for Phase 4. `src/handoff/` is empty by design.

This section will eventually document:

- what triggers escalation: policy denial, low confidence, repeated failure, unknown state
- what a paused run hands to a person, and in what form
- how control returns, and whether a human correction can be folded back into an artifact

# Safety

Placeholder for Phase 4 on guardrails. Phase 1 does implement the credential handling
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

Cuts made in later phases will be recorded here as they happen.
