# End-To-End Tests

Playwright specs that run the **published CLI as a real process** against the controlled
demo console, served over HTTP by the runner's `webServer`.

These are deliberately not a second copy of the engine suites. The Vitest tests in
`tests/` drive the engines in memory, which is what makes them fast enough to assert on
every branch and what puts the Playwright adapter and the replay engine into the coverage
measurement. Nothing there proves that the command a reviewer is handed works: that
argument parsing, configuration loading, artifact loading from disk, evidence writing, and
the process exit code all line up. That is what these specs cover.

| Spec                | Covers                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `discovery.spec.ts` | Goal, discovery, compilation, validation, verification replay, artifact |
| `replay.spec.ts`    | Deterministic replay, parameters, outcomes, recovery, policy, evidence  |

## No Model Is Called

`replay.spec.ts` runs with no model configuration at all, and one case points the provider
at a port nothing listens on to prove replay does not notice.

`discovery.spec.ts` needs a model to be a discovery run, so it starts a **stub that speaks
the local provider's chat endpoint** and returns scripted decisions. Everything else is
real: the prompt is built, sent over HTTP, parsed, and validated, and an answer outside the
decision vocabulary would still be rejected. Only which valid decision comes next is fixed.

CI therefore never calls a provider and never spends a credit. The live run against a real
site is a manual step, documented in the repository README.

## Running Them

```bash
npm run test:e2e
```

The fixture server starts automatically. To run it by itself, for the documented demo:

```bash
npm run serve:fixtures
```

Specs write evidence and capabilities into a temporary directory, never into the
repository's committed `evidence/`, which holds reviewed submission evidence.
