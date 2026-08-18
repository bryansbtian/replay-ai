# Capabilities

Committed capability artifacts produced by discovery runs and consumed by replay.

This directory is deliberately not ignored by git: example artifacts are a
deliverable of the assignment. It is empty until the artifact schema lands in
Phase 2. Override the location with `CAPABILITIES_DIR`.

Artifacts must never contain credentials, tokens, or personal data. Runtime inputs
are supplied as parameters at replay time, not baked into the artifact.
