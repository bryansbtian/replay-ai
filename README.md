# replay-ai

Computer-use automation that learns a UI workflow once and then repeats it without a
model. A natural-language goal is explored by an LLM driving a real interface during
_discovery_; a successful run is frozen into a typed, versioned **capability artifact**;
that artifact is then _replayed_ deterministically, with no LLM in the decision loop.

## Current Status

**Phase 1: repository foundation only.**

This repository currently contains the project skeleton: typed configuration, a
structured logger, a small CLI, the module boundaries the later phases will fill in,
and the full quality gate (lint, format, typecheck, tests, coverage, build, CI).

Nothing is automated yet. There is no Anthropic integration, no browser control, no
artifact schema, and no replay engine. Every directory that is still empty says so in
its own README, along with the dependencies it is allowed to have.

## Architecture

The system is a pipeline with a single shared waist. Discovery and replay are two
different ways of deciding what to do next; both apply their decisions through the same
execution layer, which is what makes a discovered run reproducible.

```text
CLI / API
   |
   +---- Discovery
   |        |
   |        +---- LLM
   |
   +---- Replay

Discovery / Replay
       |
    Artifacts
       |
    Execution
       |
  +----+-----+
  |    |     |
Surface Policy Evidence
```

Two rules matter more than the rest:

1. **`replay/` must never import from `llm/`.** Replay executes a saved capability
   without a model deciding anything, which is what makes it deterministic and cheap.
   The rule is enforced twice: an ESLint `no-restricted-imports` rule scoped to
   `src/replay/**`, and a test in `tests/architecture.test.ts` that scans imports so the
   build fails even if the lint config drifts.
2. **`config/` is the only module that reads `process.env`.** Everything else receives a
   typed, readonly `AppConfig`, so secrets travel on one code path and tests configure
   the system by passing a plain object.

## Technology Stack

| Concern         | Choice                                                  |
| --------------- | ------------------------------------------------------- |
| Runtime         | Node.js 22+ (CI runs 24 LTS), ES modules                |
| Language        | TypeScript 5.9 in strict mode, `NodeNext` resolution    |
| Validation      | Zod                                                     |
| Model access    | Anthropic SDK (wired up in Phase 2)                     |
| Browser control | Playwright (wired up in Phase 3)                        |
| Tests           | Vitest with v8 coverage, Playwright Test for end-to-end |
| Quality gate    | ESLint, Prettier, GitHub Actions                        |

## Prerequisites

- Node.js 22 or newer (`node --version`)
- npm 10 or newer
- An Anthropic API key, only for the discovery commands that arrive in Phase 2

## Installation

```bash
git clone <repository-url>
cd replay-ai
npm install
```

## Configuration

Copy the example file and fill in what you need:

```bash
cp .env.example .env
```

| Variable            | Required | Default        | Purpose                                           |
| ------------------- | -------- | -------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | No       | none           | Model access for discovery. Replay never uses it. |
| `LOG_LEVEL`         | No       | `info`         | One of `debug`, `info`, `warn`, `error`.          |
| `EVIDENCE_DIR`      | No       | `evidence`     | Where run evidence is written.                    |
| `CAPABILITIES_DIR`  | No       | `capabilities` | Where capability artifacts are read and written.  |

Notes:

- Configuration is validated on startup and fails fast with a message that names the
  offending variable and never echoes its value.
- The API key is optional so that lint, tests, builds, and replay all run without
  credentials. Commands that need it fail with an explicit message when it is absent.
- `.env` is git-ignored. Only `.env.example` is committed, and it holds placeholders.
- Relative paths resolve against the working directory.

Verify a local setup:

```bash
npx tsx src/cli/main.ts config
```

This prints one structured log record with the resolved configuration. The API key is
reported as present or absent and never printed.

## Development Commands

| Command                 | What It Does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `npm run dev`           | Runs the CLI from source in watch mode, loading `.env` if present |
| `npm run build`         | Compiles `src/` to `dist/` with type declarations                 |
| `npm run lint`          | ESLint, warnings treated as failures                              |
| `npm run lint:fix`      | ESLint with autofix                                               |
| `npm run format`        | Prettier, writes changes                                          |
| `npm run format:check`  | Prettier, verification only (used by CI)                          |
| `npm run typecheck`     | `tsc --noEmit` over sources, tests, and configs                   |
| `npm run test`          | Vitest, single run                                                |
| `npm run test:watch`    | Vitest in watch mode                                              |
| `npm run test:coverage` | Vitest with coverage and thresholds                               |
| `npm run test:e2e`      | Playwright end-to-end suite                                       |
| `npm run audit`         | `npm audit --audit-level=high`                                    |

## Testing

```bash
npm run test
npm run test:coverage
```

Unit and integration tests live in `tests/` and run under Vitest. Coverage is measured
over `src/` with a global threshold of 70 percent on lines, statements, functions, and
branches; CI fails below it.

End-to-end tests live in `tests/e2e/` and run under Playwright. There are no specs yet,
so `npm run test:e2e` passes with no tests: the harness is wired and ready for the
browser surface. Playwright browsers install with `npx playwright install chromium`.

Phase 1 tests cover configuration loading and validation, secret redaction in both the
config projection and the logger, the CLI command surface and its exit codes, and the
`replay` to `llm` dependency boundary.

## Repository Structure

```text
.github/
  workflows/ci.yml      Lint, format, typecheck, coverage, build
  workflows/codeql.yml  CodeQL scanning on push, pull request, and weekly
  dependabot.yml        Weekly npm and GitHub Actions updates
  SECURITY.md           How to report a vulnerability privately
src/
  artifacts/            Capability artifact schema and persistence (Phase 2)
  cli/                  Entry point and command surface
  config/               The only reader of process.env, Zod-validated
  discovery/            LLM-driven exploration loop (Phase 2)
  evidence/             Structured run evidence capture (Phase 3)
  execution/            Action vocabulary and executor, the shared waist (Phase 3)
  handoff/              Human handoff (Phase 4)
  llm/                  Provider-agnostic model boundary
    anthropic/          Anthropic implementation (Phase 2)
  logging/              Structured JSON logger with redaction
  policy/               Safety guardrails (Phase 4)
  replay/               Deterministic artifact execution, never imports llm/ (Phase 3)
  surfaces/             Playwright and future surface adapters (Phase 3)
  errors.ts             Shared error base with stable error codes
tests/                  Vitest suites
  e2e/                  Playwright specs
capabilities/           Committed example capability artifacts (deliverable)
evidence/               Committed example run evidence (deliverable)
```

`capabilities/` and `evidence/` are deliberately not git-ignored: example artifacts and
run evidence are project deliverables.

## Roadmap

| Phase | Scope                                                                       | Status  |
| ----- | --------------------------------------------------------------------------- | ------- |
| 1     | Repository foundation: config, logging, boundaries, quality gate, CI        | Done    |
| 2     | Anthropic integration, discovery loop, capability artifact schema           | Next    |
| 3     | Playwright surface, execution layer, deterministic replay, evidence capture | Planned |
| 4     | Policy guardrails, error taxonomy, escalation, human handoff                | Planned |

Exact commands for running discovery and replay will be added under **Development
Commands** as those phases land.

## Design Notes

See [REPORT.md](REPORT.md) for the architecture write-up, artifact schema, determinism
and error handling, escalation, safety, and the scope cuts that were made.
