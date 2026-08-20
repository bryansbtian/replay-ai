# Replay AI

Computer-use automation that discovers a UI workflow with a local LLM once, saves the
successful path as a typed capability artifact, and deterministically replays it with no
model in the decision loop.

## Architecture

Keep these boundaries clear:

- `discovery/`: LLM-driven workflow discovery
- `llm/`: Local Ollama integration
- `artifacts/`: Capability schemas, validation, and storage
- `replay/`: Deterministic execution of saved capabilities
- `surfaces/`: Computer interaction abstraction and implementations
- `policy/`: Safety and action guardrails
- `evidence/`: Structured logs and run evidence
- `handoff/`: Human intervention and control transfer
- `execution/`: Shared execution models
- `cli/`: User-facing commands

`replay/` must never depend on `llm/`. Replay executes a saved capability with no model in
the decision loop.

`discovery/` must never depend on Playwright. It drives a `ComputerSurface`.

`artifacts/` must never depend on discovery, replay, or a model runtime. The artifact is
the contract between those sides.

Prefer simple, well-defined boundaries over unnecessary abstractions or infrastructure.

## Non-Negotiable Style Rules

- Never use em dashes.
- Always use Title Case for user-facing titles and labels, especially frontend content such
  as `Workflow Job Title`, `Workflow Steps`, and section headings.
- Never use ternary operators.
- Always use curly braces for `if` statements, even for single statements.

```ts
// Correct
if (ready) {
  return;
}

// Incorrect
if (ready) return;

// Incorrect
const status = ready ? 'Ready' : 'Pending';
```

- Comments must explain **why**, not **what**.

```ts
// Correct: Retry once because legacy applications may report readiness before controls become interactive.
await retry(action);

// Incorrect: Retry the action.
await retry(action);
```

## Engineering Principles

- Use strict TypeScript and avoid `any`.
- Prefer readable control flow over clever or compact code.
- Keep third-party and vendor-specific logic isolated from core domain logic.
- Keep secrets, credentials, tokens, and sensitive data out of source code, logs, stored
  files, and tests.
- Do not add infrastructure, dependencies, interfaces, or abstractions without a concrete
  need.
- Add tests for meaningful behavior and failure cases.
- Keep changes scoped to the task being implemented.
- Update documentation when behavior or architecture changes.
- Do not claim unfinished functionality is implemented.

## Before Finishing

Run the relevant repository checks and fix all failures:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run build
```

Review the final diff for unnecessary code, unused dependencies, style violations, secrets,
and accidental scope expansion.
