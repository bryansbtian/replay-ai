# execution

What discovery and replay both need in order to execute something.

Deliberately small. It holds what has two callers today and nothing that has one. Replay
still applies a stored step through `ComputerSurface` in `replay/StepExecutor.ts`, and
discovery applies a model-proposed action in its own executor, because the two answer to
different authorities and a shared waist between them would be an abstraction with nothing
on the other side of it.

- `deadlines.ts`: the shared time bound. Both engines are bounding the same risk, and two
  copies of it would be two places for the bound to drift.
- `intervention.ts`: the seam a run asks for a person through. Replay reaches it when a
  state it cannot clear stops it; discovery reaches it when the model declines to decide.
  How the request is answered belongs entirely to `handoff/`, so this stays an interface
  with one method rather than a dependency on a session registry or a server.

Depends on: nothing. That is what keeps `replay/` free of `handoff/` and `llm/`.
