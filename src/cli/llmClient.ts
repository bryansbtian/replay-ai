import { requireAnthropicApiKey, type AppConfig } from '../config/index.js';
import { AnthropicClient } from '../llm/anthropic/index.js';
import type { LLMClient } from '../llm/index.js';
import { OllamaClient } from '../llm/ollama/index.js';

/**
 * Chooses a model boundary implementation, and the only place in the system that names
 * one.
 *
 * This is a composition root, which is why it is allowed to import both providers. The
 * engine that receives the result knows `LLMClient` and cannot tell which it was handed,
 * so adding a third provider is a case in this switch and nothing else.
 *
 * The credential is read here and passed to the client that needs it, so no other module
 * touches one. A deployment using the local provider is never asked for a key, which is
 * what keeps every command that does not call a hosted API runnable without one.
 */
export function createLlmClient(config: AppConfig): LLMClient {
  if (config.llm.provider === 'anthropic') {
    return new AnthropicClient({
      apiKey: requireAnthropicApiKey(config),
      model: config.llm.model,
    });
  }

  return new OllamaClient({
    // Present by construction for this provider; the check keeps the type honest rather
    // than asserting one.
    baseUrl: config.llm.baseUrl ?? 'http://127.0.0.1:11434',
    model: config.llm.model,
  });
}
