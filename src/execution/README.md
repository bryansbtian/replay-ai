# execution

The action vocabulary and the executor that applies one action to one surface, shared by
discovery and replay.

Still empty, and deliberately so. Replay applies a step through `ComputerSurface`
directly, in `replay/StepExecutor.ts`; there is only one caller, so a shared waist would
be an abstraction with nothing on the other side of it. It earns its place when discovery
arrives and two callers need the same executor.

Depends on: `surfaces`, `policy`, `evidence`.
