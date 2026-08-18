# evidence

The durable, sanitized record of one automation run.

Not a copy of the developer log. A log is a stream someone watches while a run happens;
evidence is written so that someone who was not there can answer what ran, what it was
allowed to do, what happened, and where it stopped.

```text
<EVIDENCE_DIR>/runs/<runId>/
  metadata.json      the manifest: capability, policy in force, outcome, warnings
  events.jsonl       one JSON document per line, in order
  screenshots/       the richer signal for the failure that ended the run
```

- Redaction rules come from `src/redaction.ts`, shared with the logger, so a secret
  cannot be scrubbed from one and printed by the other.
- Invocation values are never persisted, only input names.
- An event or a screenshot that cannot be written becomes a warning on the manifest. A
  manifest that cannot be written throws, because a run directory that says nothing about
  the run is an observability failure worth hearing about.

Depends on: `redaction`, `policy` (the summary type).
Must never depend on: `replay`, `discovery`, `llm`, or a browser library.
