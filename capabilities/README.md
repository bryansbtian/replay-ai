# Capabilities

Capability artifacts: one JSON document per capability, holding the ordered steps, the
targets, the typed inputs and outputs, the success condition, and the application states
the capability recognizes.

This directory is deliberately not ignored by git: the compiled artifact is a deliverable
of the assignment. Override the location with `CAPABILITIES_DIR`.

`FileArtifactStore` reads and writes artifacts in the top level of this directory, named
`<id>.json`. The one installed capability is `search-restaurants-by-cuisine.json`,
compiled from the live SeatPing discovery run listed in
[`evidence/README.md`](../evidence/README.md).

Artifacts used only by the test suite live in
[`tests/fixtures/capabilities/`](../tests/fixtures/capabilities/), against the local
fixture site rather than SeatPing, so that this directory holds the submission artifact
and nothing else.

## Version 1 Is Compiled. Version 2 Is Reviewed.

Discovery compiles version 1 from what actually happened, and the compiler refuses to
invent anything the run did not demonstrate. A happy-path run never sees an empty result,
so it cannot know that "No Restaurants Found" is an answer rather than a fault, and it
proposes locators from the one screen it saw. Both are for a person to settle, which is
what makes an artifact reviewable rather than merely generated.

`search-restaurants-by-cuisine.json` shows the two edits that review made:

- **A declared business outcome.** `NO_RESTAURANTS_FOUND` turns "nothing matched" into a
  result the caller is told about, instead of a replay that fails.
- **A generalized locator.** Discovery targeted the result count by the exact text it saw
  on the day, `1 result for "Japanese"`. Review replaced that with the heading whose
  accessible name contains `for "`, falling back to the page's single `h1`, so the same
  capability reads the count for any search term.

Both changes were verified by replaying the reviewed artifact, and those runs are the
committed replay evidence.

Artifacts must never contain credentials, tokens, cookies, model transcripts, or
personal data. Runtime values are supplied as declared inputs at replay time and are
never baked into the file. The schema rejects unknown keys, so there is nowhere for
unmodelled data to be smuggled in.

See [the artifact package](../src/artifacts/README.md) for the schema, and
[REPORT.md](../REPORT.md#artifact-schema) for the design reasoning.
