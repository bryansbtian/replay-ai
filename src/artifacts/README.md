# artifacts

The capability artifact: the typed, versioned, serializable contract that a discovery
run will produce and a deterministic replay will execute.

Everything here is data and a validator for it. Nothing in this directory executes a
step, opens a browser, or talks to a model.

| File               | Responsibility                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `artifact.ts`      | The capability envelope, the schema version, inputs, outputs, metadata |
| `steps.ts`         | Values, targets, checkpoints, and the step union                       |
| `identifiers.ts`   | The identifier rules the schema and the store both depend on           |
| `validation.ts`    | `parseCapabilityArtifact`, the single entry point for unknown data     |
| `semantics.ts`     | Cross-field rules a schema cannot express                              |
| `serialization.ts` | Canonical JSON out, validated JSON in                                  |
| `store.ts`         | `FileArtifactStore`: artifacts as files in a directory                 |
| `errors.ts`        | Typed failures, and the boundary where Zod issues stop                 |

Depends on: `surfaces` (the `Target` and `LocatorStrategy` model only), and the shared
error base.

Must not depend on: `llm/`, `discovery/`, `replay/`, `surfaces/playwright/`, or any
model SDK. Enforced by a scoped ESLint rule and by `tests/architecture.test.ts`.
