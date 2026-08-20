# Replay AI

## Introduction

Computer-use automation that discovers a UI workflow with a local LLM once, saves the
successful path as a typed capability artifact, and replays that artifact deterministically
with no model in the decision loop. It is for driving applications that expose no API,
where the only way in is the interface a human operator uses.

**Discovery uses Ollama. Replay does not.** The local model works out the workflow once.
Replay AI saves it as a typed capability. Future executions use deterministic replay.

## Development Setup

Prerequisites: Node.js 24+, and [Ollama](https://ollama.com) only if you will run live
discovery. Replay needs none of the model pieces.

```bash
cp .env.example .env
npm ci
npx playwright install chromium
```

`npm ci` installs exactly what `package-lock.json` records, so every machine and CI get the
same tree. Use `npm install` only to add, remove, or upgrade a dependency, and commit the
updated lockfile.

For live discovery, pull the default model and confirm the daemon is on loopback:

```bash
ollama pull gemma3:27b
```

The daemon should listen on `http://127.0.0.1:11434`.

## Run Locally

There is no long-running server. The CLI is the product: `discover` uses Ollama, `replay`
does not. List every host you will open in `POLICY_ALLOWED_HOSTS` in `.env`. SeatPing is
one more host on that list, not a special command. Do not log in, join a queue, book a
table, or submit anything. CI does not load `.env` and never automates the live site.

### Discover

```bash
npm run discover -- [args]
```

| Arg                               | Required | What it does                                                     |
| --------------------------------- | -------- | ---------------------------------------------------------------- |
| `--goal <text>`                   | Yes      | What the run should achieve, in plain language                   |
| `--target <url>`                  | Yes      | Where the application starts                                     |
| `--name <text>`                   | No       | Application name in the prompt. Defaults to the host             |
| `--input name=value`              | No       | Value the run should use. Repeatable. Becomes a capability input |
| `--max-steps <n>`                 | No       | Model decisions the run may carry out                            |
| `--timeout <ms>`                  | No       | Wall-clock ceiling for the whole run                             |
| `--headed`                        | No       | Show the browser window                                          |
| `--capability-name <text>`        | No       | Title Case name. Supplying it compiles a reusable capability     |
| `--capability-description <text>` | No       | What the capability does. Defaults to the goal                   |
| `--capability-id <slug>`          | No       | File name in `capabilities/`. Derived from the name              |
| `--overwrite`                     | No       | Replace a capability that already exists under that id           |

**Demo, Step One: Discover**

Needs Ollama. This is the only step a model is involved in.

```bash
npm run discover -- --goal "Search SeatPing for Japanese restaurants, reach the search results, and read the heading that reports how many results were found." --target https://seatping.biz --name SeatPing --input cuisine=Japanese --capability-name "Search Restaurants By Cuisine" --capability-id search-restaurants-by-cuisine --capability-description "Searches SeatPing for restaurants matching a cuisine and reads the result count from the search results page." --headed --overwrite --timeout 900000
```

The run writes `capabilities/search-restaurants-by-cuisine.json` and its evidence
directory, and only after replaying the compiled artifact once to verify it. A model
decides nothing after this command returns.

A discovery run is a live model driving a live site, so it is not deterministic: it may
stop on a loop guard and need running again. The committed artifact and the committed
evidence are from a run that succeeded.

### Replay

```bash
npm run replay -- [args]
```

| Arg                  | Required | What it does                                                                            |
| -------------------- | -------- | --------------------------------------------------------------------------------------- |
| `--artifact <path>`  | One of   | Path to a capability JSON file                                                          |
| `--capability <id>`  | One of   | Id of an artifact in the configured capabilities directory                              |
| `--input name=value` | No       | Invocation input. Repeatable                                                            |
| `--headed`           | No       | Show the browser window. Types each field visibly and waits a few seconds between steps |
| `--handoff`          | No       | Pause for a person when the run cannot continue. Implies `--headed`                     |

`--artifact` and `--capability` are mutually exclusive. One of them is required.

**Demo, Step Two: Replay**

Needs no model, and no provider has to be reachable.

```bash
npm run replay -- --capability search-restaurants-by-cuisine --input cuisine=Japanese --headed
```

Prints the structured result on stdout: the capability, the steps that completed, and the
declared output, which is the result count read off the page on this run.

**Demo, Step Three: The Other Outcomes**

The same capability, run three more ways, to show that a replay reports what actually
happened rather than succeeding or crashing.

```bash
# A search nothing matches. A declared business outcome, not a failure. Exit code 2.
npm run replay -- --capability search-restaurants-by-cuisine --input cuisine=Zzqxwv

# A required input that was not supplied. Fails closed before the browser opens. Exit 1.
npm run replay -- --capability search-restaurants-by-cuisine

# A deployment whose allowlist does not include the target. Refused at the first
# navigation, before anything is driven. Exit code 3.
POLICY_ALLOWED_HOSTS=example.test npm run replay -- --capability search-restaurants-by-cuisine --input cuisine=Japanese
```

Every one of these writes an evidence directory. The committed runs are the ones that
completed against the live site, and what each one demonstrates is listed in
[`evidence/README.md`](evidence/README.md). The refusal and failure paths are asserted
against the local fixture in `tests/e2e/replay.spec.ts` rather than committed as evidence
from a deliberately broken run against somebody else's public service.

### Human Handoff

`--handoff` turns on the escalation path. When a replay meets a state it cannot clear,
policy requires a confirmation, or discovery asks for a person, the run pauses instead of
failing: the coordinator marks the session as under human control, captures a screenshot,
and raises an intervention carrying the capability, the step, why it stopped, and where.
The command prints a local operator URL before anything can pause.

```bash
npm run replay -- --capability search-restaurants-by-cuisine --input cuisine=Japanese --handoff
```

The operator page shows the intervention and that screenshot, and offers Take Control,
Resume, and Abort. Taking control hands over the same browser window the automation was
driving, with the same context, cookies, and half-filled form. What the person clicks and
types there is recorded as evidence that a person acted. Resume re-observes the page and
carries on only if the expected state now holds. There is one owner at a time: automation
cannot act while a person holds the session.

The handoff is not exercised against SeatPing, because pausing a run on somebody else's
live site to hand over a browser is not a thing to do to a public service. The full loop,
including a person fixing the page and the run then completing, is proven against the
local fixture in `tests/handoff/browserHandoff.test.ts`.

## Build

```bash
npm run build
```

Output goes to `dist/`. There is no `start` script: invoke the built CLI with `node`.

## Testing

| Command                 | What it runs                                                                                | Needs    |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `npm test`              | Vitest: unit and in-process integration, including a real browser against the local fixture | Chromium |
| `npm run test:watch`    | The same suite in watch mode                                                                | Chromium |
| `npm run test:coverage` | Everything, plus the 70% gate                                                               | Chromium |
| `npm run test:e2e`      | Playwright runner spawning the published CLI as a subprocess                                | Chromium |

**Running Without Live Services.** Everything except the discovery demo can be exercised
with no network and no model. `npm run serve:fixtures` serves the controlled member console
at `http://127.0.0.1:3100/member-lookup.html`, and the suites drive the real engines and a
real browser against it: business outcomes, declared recoveries, hard failures, policy
blocks, and the full human handoff. Discovery E2E scripts a local stub that speaks Ollama's
chat endpoint. Replay E2E is given no model at all. Neither suite replaces the live SeatPing run.

## Common Commands

| Command                  | What it does                       |
| ------------------------ | ---------------------------------- |
| `npm run dev`            | Watch the CLI entrypoint           |
| `npm run discover`       | Live discovery (uses Ollama)       |
| `npm run replay`         | Deterministic replay (no model)    |
| `npm run serve:fixtures` | Local member-console fixture       |
| `npm run build`          | Compile to `dist/`                 |
| `npm run lint`           | ESLint, warnings treated as errors |
| `npm run format:check`   | Prettier, verification only        |
| `npm run typecheck`      | `tsc --noEmit`                     |
| `npm run test:coverage`  | Tests with the coverage gate       |
| `npm run test:e2e`       | CLI subprocess specs               |

## Development Notes

```text
src/
  artifacts/      capability schema, validation, storage
  cli/            discover, replay, config
  compilation/    trace -> artifact, then verification replay
  config/         the only reader of process.env
  discovery/      observe / decide / act loop
  evidence/       run records
  execution/      shared intervention seam
  handoff/        session ownership and control transfer
  llm/            LLMClient contract and the Ollama client
  logging/        structured logs, same redaction as evidence
  operator/       local operator page for handoff
  policy/         deny-by-default safety authority
  replay/         deterministic executor
  surfaces/       ComputerSurface and the Playwright adapter
capabilities/     the compiled submission artifact
evidence/         committed run records
```

`replay/` must never import `llm/` or `discovery/`. `discovery/` must never import
Playwright. `artifacts/` must never import discovery, replay, or a model client. The rules
are enforced by ESLint and `tests/architecture.test.ts`.

Policy is the authority. An artifact describes a workflow and cannot authorize itself.
Changing a host allowlist, a risk disposition, or an action list is a deployment change,
not an artifact change.

Each run writes `evidence/runs/<run-id>/`. Canonical submission run IDs are listed in
[`evidence/README.md`](evidence/README.md). Fill values, credentials, cookies, query
values, and model transcripts are not written.

Known limitations, and what was deliberately not built, are in [`REPORT.md`](REPORT.md).

## Contribution Rules

- Create a new branch from `main` for every change.
- Do not commit directly to `main`.
- Open a pull request into `main` when the change is ready.
- Keep pull requests small, focused, and easy to review.
- Run `npm run lint` and `npm run build` before opening a pull request.
- Do not create commits unless explicitly asked.
- Before finishing, summarize what changed, what commands were run, what commands could not
  be run, and any remaining risks.
