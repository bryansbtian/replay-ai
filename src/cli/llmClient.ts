import type { AppConfig } from '../config/index.js';
import type { LLMClient } from '../llm/index.js';
import { OllamaClient } from '../llm/ollama/index.js';

/**
 * Builds the model boundary implementation, and the only place in the system that names
 * one.
 *
 * This is a composition root, which is why it is allowed to import the provider. The
 * engine that receives the result knows `LLMClient` and cannot tell which it was handed,
 * so a second runtime is a change here and nowhere else.
 *
 * The local runtime needs no credential, which is what keeps every command runnable
 * without an account or a key.
 */
export function createLlmClient(config: AppConfig): LLMClient {
  return new OllamaClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
  });
}
