# replay

Deterministic execution of a saved capability artifact. No LLM in the decision loop:
given the same artifact and the same inputs, replay issues the same operations in the
same order, or fails with a structured result saying where and why.

```text
validate inputs -> execute artifact.steps in order -> verify the success condition
  -> collect declared outputs -> return a ReplayResult
```

- `ReplayEngine` owns the sequence and turns everything that happens into one result.
- `StepExecutor` applies one step and bounds its attempts.
- `CheckpointEvaluator` asks the surface whether a state holds, keeping what was
  expected next to what was observed.
- `InputValidator` and `ParameterResolver` decide what a step types, before anything is
  touched and without any expression evaluation.
- `OutputCollector` turns extracted text into the declared output types, or refuses.
- `deadlines.ts` holds the budget hierarchy and the outer bound that stops a run hanging.

Depends on: `artifacts`, `surfaces` (the contract only), `logging`.
Must never depend on: `llm`, `discovery`, a model SDK, or Playwright. Enforced by a
scoped ESLint rule and by `tests/architecture.test.ts`.
