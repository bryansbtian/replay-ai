# handoff

Human handoff: how a run pauses, what it hands a person, and how control comes back.

```text
AutomationSession    who may act, as a state machine rather than a set of flags
HandoffCoordinator   the pause, the transfer, and the record of both
InterventionRequest  what an operator is shown. Already safe to render
SessionRegistry      the sessions this process is running, by id
```

Depends on: `execution` (the intervention contract), `evidence`, `surfaces` (the contract
only), `logging`, `redaction`.

Must not import `replay`, `discovery`, `compilation`, the `llm` layer, or Playwright.
Control transfer is about who may act, not about what they were doing, so the same mechanism
serves both engines. Enforced by a scoped ESLint rule and by `tests/architecture.test.ts`.

Replay and discovery do not import this module. They depend on
`execution/intervention`, which is one interface with two methods, so neither engine can be
made to care whether a person was reachable.

The registry is in memory and local to the process. That is a deliberate cut: a paused
session's value is the live browser it points at, and that does not outlive the process
either.
