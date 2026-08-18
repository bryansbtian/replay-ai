# policy

The safety boundary. Every action is evaluated here before it happens.

The rule the whole package exists to enforce: **an artifact describes what an action is,
and never grants permission to perform it.** A capability may say a step is `safe`; only
this deployment's configuration decides whether a `safe` step may run at all.

- `types.ts` holds the vocabulary: what an action must state about itself
  (`PolicyContext`), and what comes back (`PolicyDecision`, with a reason).
- `config.ts` is what a deployment permits, validated at load. Every default is the
  cautious one, so an unset setting can only make the system refuse more.
- `url.ts` compares parsed URLs, never substrings.
- `StaticPolicyEngine.ts` evaluates a context against a configuration. Pure and
  synchronous: no file, no network, nothing that can fail open.

Reusable by replay today and by the discovery loop of a later phase, which is why nothing
here knows who proposed the action.

Depends on: `artifacts` (the action and risk vocabularies, as types).
Must never depend on: `replay`, `discovery`, `llm`, a model SDK, or a browser library.
Enforced by a scoped ESLint rule and by `tests/architecture.test.ts`.
