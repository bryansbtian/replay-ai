# llm

Model-facing boundary. `LLMClient` is one method that takes text and returns text, which is
what lets discovery work without knowing which runtime answered.

```text
LLMClient.ts       the provider-independent contract
errors.ts          the domain failure codes every provider maps onto
ollama/            a model running on the operator's own machine, over plain HTTP
```

Nothing under `replay/` may import from this directory. Replay executes saved capabilities
without a model in the decision loop, and that boundary is enforced by an ESLint rule plus
a test in `tests/architecture.test.ts`.

Discovery depends on this directory's root only. The provider implementation is imported
solely by a composition root under `cli/`, which a test also enforces.

The client returns nothing but the text of the answer. `ModelResponse` has no field for a
raw body, a transcript, or reasoning, so there is no path by which those could reach a log
or an evidence file.
