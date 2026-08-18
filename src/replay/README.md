# replay

Deterministic execution of a saved capability artifact. No LLM in the decision loop:
given the same artifact and the same inputs, replay issues the same operations in the
same order, or fails with a structured result saying where and why.

```text
validate inputs -> execute artifact.steps in order -> verify the success condition
  -> collect declared outputs -> return a ReplayResult
```

When a step does not succeed, three questions decide what happened, in this order:

```text
1. Is this a state the capability declares?   -> business outcome, or a declared failure
2. Is this a state the capability can clear?  -> recover, then retry the step
3. Neither                                    -> hard failure, and stop
```

- `ReplayEngine` owns the sequence, the three questions, and the one result.
- `StepExecutor` applies one step and bounds its attempts.
- `classification.ts` is the only module that knows the surface error types: it turns one
  into a stable code, and nothing else in the engine uses `instanceof`.
- `RecoveryPlanner` recognizes a declared condition and activates the one control the
  artifact named for it. It never touches anything the artifact did not name.
- `CheckpointEvaluator` asks the surface whether a state holds, keeping what was
  expected next to what was observed.
- `InputValidator` and `ParameterResolver` decide what a step types, before anything is
  touched and without any expression evaluation.
- `OutputCollector` turns extracted text into the declared output types, or refuses.
- `deadlines.ts` holds the budget hierarchy and the outer bound that stops a run hanging.

Depends on: `artifacts`, `surfaces` (the contract only), `logging`.
Must never depend on: `llm`, `discovery`, a model SDK, or Playwright. Enforced by a
scoped ESLint rule and by `tests/architecture.test.ts`.
