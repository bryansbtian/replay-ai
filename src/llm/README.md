# llm

Model-facing boundary. Defines the provider-agnostic interface discovery talks to;
`llm/anthropic` holds the Anthropic implementation.

Nothing under `replay/` may import from this directory. Replay executes saved
capabilities without a model in the decision loop, and that boundary is enforced by
an ESLint rule plus a test in `tests/architecture.test.ts`.

Empty in Phase 1. `@anthropic-ai/sdk` is already declared as a dependency so the client
version is pinned alongside the rest of the stack, but nothing imports it yet.
