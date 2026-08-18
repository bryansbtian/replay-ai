# Capabilities

Capability artifacts: one JSON document per capability, holding the ordered steps, the
targets, the typed inputs and outputs, and the success condition of a workflow.

This directory is deliberately not ignored by git: example artifacts are a deliverable
of the assignment. Override the location with `CAPABILITIES_DIR`.

- `FileArtifactStore` reads and writes artifacts in the top level of this directory,
  named `<id>.json`.
- `examples/` holds committed examples. The store ignores subdirectories, so an example
  is documentation and a test fixture rather than an installed capability.

Artifacts must never contain credentials, tokens, cookies, model transcripts, or
personal data. Runtime values are supplied as declared inputs at replay time and are
never baked into the file. The schema rejects unknown keys, so there is nowhere for
unmodelled data to be smuggled in.

See [the artifact package](../src/artifacts/README.md) for the schema, and
[REPORT.md](../REPORT.md#artifact-schema) for the design reasoning.
