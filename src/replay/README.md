# replay

Deterministic execution of a saved capability artifact. No LLM in the decision loop:
given the same artifact and the same inputs, replay takes the same steps or fails
with a typed error.

Depends on: `artifacts`, `execution`, `evidence`, `policy`.
Must never depend on: `llm`, `discovery`.

Empty in Phase 1.
