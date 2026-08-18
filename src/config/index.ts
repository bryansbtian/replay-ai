import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { ConfigurationError } from '../errors.js';
import { LOG_LEVELS, type LogLevel } from '../logging/logger.js';
import { DEFAULT_SURFACE_TIMEOUTS, type SurfaceTimeouts } from '../surfaces/timeouts.js';

/**
 * The single place the process reads environment variables. Every other module
 * receives an `AppConfig` instead of touching `process.env`, which keeps secrets
 * on one code path and makes configuration trivially fakeable in tests.
 */

/**
 * Milliseconds, supplied as a string by the environment. Coerced rather than parsed by
 * hand so that a non-numeric value is a configuration error instead of a `NaN` timeout
 * that would make a wait never fire.
 */
const timeoutMs = z.coerce
  .number({ error: 'must be a whole number of milliseconds' })
  .int('must be a whole number of milliseconds')
  .positive('must be greater than zero');

const envSchema = z.object({
  // Optional so that lint, tests and offline commands run without credentials.
  // Commands that call Anthropic obtain it through `requireAnthropicApiKey`.
  ANTHROPIC_API_KEY: z.string().min(1, 'must not be empty when set').optional(),
  // Custom messages throughout: the default issue text can echo the received value,
  // and an invalid value may itself be a secret.
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  EVIDENCE_DIR: z.string().min(1, 'must not be empty').default('evidence'),
  CAPABILITIES_DIR: z.string().min(1, 'must not be empty').default('capabilities'),
  // Surface waiting budgets. Defaults live with the surface so there is one source of
  // truth for what a reasonable wait is.
  SURFACE_NAVIGATION_TIMEOUT_MS: timeoutMs.default(DEFAULT_SURFACE_TIMEOUTS.navigationMs),
  SURFACE_LOCATOR_TIMEOUT_MS: timeoutMs.default(DEFAULT_SURFACE_TIMEOUTS.locatorMs),
  SURFACE_ACTION_TIMEOUT_MS: timeoutMs.default(DEFAULT_SURFACE_TIMEOUTS.actionMs),
});

export interface AppConfig {
  readonly logLevel: LogLevel;
  /** Absolute path to the directory holding run evidence. */
  readonly evidenceDir: string;
  /** Absolute path to the directory holding capability artifacts. */
  readonly capabilitiesDir: string;
  /** Waiting budgets handed to a `ComputerSurface`. */
  readonly surfaceTimeouts: SurfaceTimeouts;
  /** Present only when supplied; never logged or serialized. */
  readonly anthropicApiKey?: string;
}

/**
 * Config with every secret removed, safe to log or print. A type alias rather than an
 * interface so it satisfies the logger's structured-field record type.
 */
export type SafeConfig = {
  readonly logLevel: LogLevel;
  readonly evidenceDir: string;
  readonly capabilitiesDir: string;
  readonly surfaceTimeouts: SurfaceTimeouts;
  readonly anthropicApiKeyPresent: boolean;
};

export interface LoadConfigOptions {
  /** Base directory used to resolve relative paths. Defaults to the process cwd. */
  readonly cwd?: string;
}

function toAbsolutePath(value: string, cwd: string): string {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(cwd, value);
}

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `  ${path}: ${issue.message}`;
  });
  return lines.join('\n');
}

/**
 * Validates the environment and returns typed configuration.
 *
 * @throws ConfigurationError when a variable is missing or invalid. The error
 * message names the offending variables and never echoes their values, because
 * an invalid value can still be a secret.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration:\n${formatIssues(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const base: AppConfig = {
    logLevel: parsed.data.LOG_LEVEL,
    evidenceDir: toAbsolutePath(parsed.data.EVIDENCE_DIR, cwd),
    capabilitiesDir: toAbsolutePath(parsed.data.CAPABILITIES_DIR, cwd),
    surfaceTimeouts: {
      navigationMs: parsed.data.SURFACE_NAVIGATION_TIMEOUT_MS,
      locatorMs: parsed.data.SURFACE_LOCATOR_TIMEOUT_MS,
      actionMs: parsed.data.SURFACE_ACTION_TIMEOUT_MS,
    },
  };

  const apiKey = parsed.data.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    return base;
  }
  return { ...base, anthropicApiKey: apiKey };
}

/**
 * Returns the Anthropic API key, failing fast with an actionable message when a
 * command that needs live model access was started without one.
 */
export function requireAnthropicApiKey(config: AppConfig): string {
  const apiKey = config.anthropicApiKey;
  if (apiKey === undefined) {
    throw new ConfigurationError(
      'ANTHROPIC_API_KEY is required for this command. Set it in your environment or .env file (see .env.example).',
    );
  }
  return apiKey;
}

/** Projects config down to fields that are safe to log or print. */
export function toSafeConfig(config: AppConfig): SafeConfig {
  return {
    logLevel: config.logLevel,
    evidenceDir: config.evidenceDir,
    capabilitiesDir: config.capabilitiesDir,
    surfaceTimeouts: config.surfaceTimeouts,
    anthropicApiKeyPresent: config.anthropicApiKey !== undefined,
  };
}
