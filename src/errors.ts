/**
 * Minimal shared error foundation.
 *
 * Phase 1 only needs a base class that carries a stable machine-readable code and
 * preserves the underlying cause. The full execution error taxonomy (retryable vs
 * terminal, escalation triggers, evidence linkage) is designed in a later phase.
 */
export class ReplayAiError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Raised when environment configuration is missing or invalid. */
export class ConfigurationError extends ReplayAiError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CONFIG_INVALID', options);
  }
}
