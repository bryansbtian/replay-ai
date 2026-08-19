# compilation

Turns a successful discovery trace into a reusable capability artifact, and refuses to save
one that does not work.

```text
ArtifactCompiler     compile, validate, verify by replaying, then save
TraceCompiler        the deterministic trace to artifact transformation
stepNaming           readable, unique step ids
CompilationRequest   what the run cannot know: the name, the description, declared outcomes
CompilationResult    compiled, or rejected with the stage that could not continue
```

Depends on: `discovery` (trace models only), `artifacts`, `surfaces` (the target model
only), `replay` (to verify), `policy`, `evidence`.

Must not import a model SDK, the `llm` layer, or Playwright. Compilation is deterministic:
the same trace and request always produce the same artifact, which is what makes a
generated capability reviewable rather than merely trusted. Enforced by a scoped ESLint
rule and by `tests/architecture.test.ts`.

Nothing under `replay/` may import from here. Replay is a standalone consumer of validated
artifacts and does not know where one came from.
