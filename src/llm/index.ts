/**
 * The model-facing boundary discovery talks to.
 *
 * Nothing under `replay/` may import from here: replay executes a saved capability with
 * no model in its decision loop, and that rule is enforced by an ESLint restriction and
 * by `tests/architecture.test.ts`. The Ollama implementation lives in `./ollama` and is
 * imported only by a composition root.
 */
export { MODEL_FAILURE_CODES, ModelError, type ModelFailureCode } from './errors.js';
export type { LLMClient, ModelRequest, ModelResponse } from './LLMClient.js';
