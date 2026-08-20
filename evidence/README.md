# Evidence

Committed run records: one directory per run, holding `metadata.json`, `events.jsonl`,
and, when a run stopped somewhere unexpected, `screenshots/`.

This directory is deliberately not ignored by git. Example evidence is a deliverable.
Override the location with `EVIDENCE_DIR`.

Anything committed here is reviewed first. No credentials, no tokens, no personal data,
no machine-specific absolute paths, no raw model transcripts, no chain-of-thought.

## Canonical Submission Runs

Live SeatPing restaurant search at `https://seatping.biz`. Read-only: the runs search for
a term and read the result count. They do not log in, open a restaurant, book a table, or
join a queue. The capability they use is
[`capabilities/search-restaurants-by-cuisine.json`](../capabilities/search-restaurants-by-cuisine.json).

Every run committed here completed. Nothing in this directory is a broken run.

| What                                              | Invocation               | Run ID                                 |
| ------------------------------------------------- | ------------------------ | -------------------------------------- |
| Live Discovery (`gemma3:27b`)                     | goal, `cuisine=Japanese` | `562be91a-73ee-4d0d-8a0c-46d81bc44dd8` |
| Verification Replay, Run By The Compiler          | `cuisine=Japanese`       | `6538e97c-24e9-46ab-8d6f-595501f174e4` |
| Replay: Success, With The Declared Output         | `cuisine=Japanese`       | `9d5c671d-b03f-4bae-adb0-8f7458f6fac9` |
| Replay: Business Outcome (`NO_RESTAURANTS_FOUND`) | `cuisine=Zzqxwv`         | `f5e834c9-cea4-4e6e-9746-a0ad3a53475a` |

## What Each Run Shows

**Discovery** is a genuine local-model run. The model was given the goal and the entry
point, saw one screen at a time, and chose to fill the search field, submit it, and read
the result count heading. It never saw this repository's code and never wrote a step id.
The compiler turned that trace into version 1 of the capability and only wrote the file
after replaying it, which is the **verification replay**. Version 2 is the same artifact
after review; what review changed and why is in
[`capabilities/README.md`](../capabilities/README.md).

The two replays of the reviewed artifact are the result contract, one run each:

- **Success** returns `resultCount` for whichever term was asked for. The value is read
  from the page on every run and is not stored in the artifact.
- **Business outcome** is SeatPing answering "No Restaurants Found". `NO_RESTAURANTS_FOUND`
  with exit code 2. Nothing is broken and nothing needs debugging, and a caller can tell
  this apart from an automation that fell over. This is the run that shows the two are
  distinct outcomes rather than one bucket.

## Where The Failure Paths Are Proven

The rest of the result contract is exercised against the controlled local fixture instead
of the live site, and is not committed here. Deliberately failing a run against somebody
else's public service to produce a souvenir directory is not a thing to do to it, and an
injected fault against a healthy site proves less than a test that can assert on the
outcome. The specs in [`tests/e2e/replay.spec.ts`](../tests/e2e/replay.spec.ts) drive the
published CLI as a subprocess and cover:

- A required input that was not supplied, failing closed before the browser opens.
- A deployment whose host allowlist does not include the target, refused at the first
  navigation with exit code 3.
- A deployment configured read-only, refused before a write action runs.
- A state nothing declares, reported with a structured diagnosis rather than as success.
- A declared recovery, which the run reports having taken.
- An evidence directory written for every run, whatever the outcome.

## Reading A Run

`metadata.json` is the manifest: what ran, the policy in force, when it started and
finished, and how it ended. `kind` says whether the run was a `discovery` or a `replay`.
On a failure, `failureKind` says which class of failure ended it. They are separate fields
so that a failed replay still says it was a replay.

`events.jsonl` is one JSON object per line, in order. The event vocabulary is closed and
listed in [`src/evidence/types.ts`](../src/evidence/types.ts).

What is deliberately absent: fill values, invocation inputs, extracted values, query
strings, cookies, authorization headers, prompts, and model responses. A model event
records that a decision was asked for and what type came back, with sizes and timings,
never the text.

## What Is Not Here

Human handoff is not exercised against SeatPing. Pausing a run on somebody else's live
site to hand a browser to a person is not a thing to do to a public service, so the
handoff proof is `tests/handoff/browserHandoff.test.ts`, which drives the whole loop
against the controlled local fixture in a real browser: replay stops, an intervention is
raised, a person acts on the same page, control is handed back, and the run completes.

The end-to-end specs write into a temporary directory rather than here, because this
directory holds reviewed submission evidence and a test appending to it would make the
committed set impossible to reason about. CI never records runs here and never automates
`seatping.biz`.
