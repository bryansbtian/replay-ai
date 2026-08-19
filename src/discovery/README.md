# discovery

The exploration loop. Takes a natural-language goal and a target application, drives a
`ComputerSurface` one action at a time using a model, and records what happened.

```text
DiscoveryEngine   the observe, decide, act loop
AgentDecision     what the model may say, and the validation that proves it said it
DiscoveryResult   success, failure, or escalation
DiscoveryTrace    the ordered in-memory record of a run
DiscoveryJournal  the two sinks a run writes to, and what they refuse to carry
LoopGuard         mechanical protection against a run that will not end
policyGate        where a proposed action becomes a question for the safety boundary
prompt            everything the model is told, in one reviewable place
```

Depends on: `llm` (the generic client only), `surfaces` (the contract only), `execution`,
`artifacts` (for the target and checkpoint schemas), `policy`, `evidence`.

Must not import a provider implementation (`llm/anthropic`, `llm/ollama`), a model SDK,
Playwright, or `replay`. A composition root under `cli/` chooses the provider and the
surface. Enforced by a scoped ESLint rule and by `tests/architecture.test.ts`.

A successful run produces a `DiscoveryTrace`, not a capability artifact. Compiling one into
the other is Phase 8's work and is deliberately not started here.
