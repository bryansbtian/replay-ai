import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { DEFAULT_LOOP_LIMITS } from '../discovery/index.js';
import { ConfigurationError } from '../errors.js';
import { LOG_LEVELS, type LogLevel } from '../logging/logger.js';
import { policyConfigSchema, type PolicyConfig } from '../policy/index.js';
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

/**
 * A comma-separated environment value, as the list it names.
 *
 * Empty entries are dropped so that a trailing comma or a blank variable is a shorter
 * list rather than a list containing "", which would be an allowlist entry matching
 * nothing and confusing to debug.
 */
const commaSeparated = z.string().transform((value) => {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
});

/**
 * The model providers this deployment can be pointed at.
 *
 * Both implement the same one-method boundary, and discovery is handed one without being
 * told which. Naming them here rather than in discovery is what keeps the choice a
 * deployment decision instead of a code path.
 */
export const LLM_PROVIDERS = ['ollama', 'anthropic'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Which model answers, and where it lives. Never carries a credential. */
export interface LlmConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  /** Where a locally hosted provider listens. Absent for a hosted API. */
  readonly baseUrl?: string;
}

/** What bounds a discovery run. The model cannot see or raise either of them. */
export interface DiscoveryConfig {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

const envSchema = z.object({
  // Optional so that lint, tests and offline commands run without credentials.
  // Commands that call Anthropic obtain it through `requireAnthropicApiKey`.
  ANTHROPIC_API_KEY: z.string().min(1, 'must not be empty when set').optional(),
  // Which implementation of the model boundary a discovery run is given. Defaulting to
  // the local provider means the repository is runnable with no account and no key, and
  // the hosted one is a variable away rather than a code change.
  LLM_PROVIDER: z
    .enum(LLM_PROVIDERS, { error: `must be one of ${LLM_PROVIDERS.join(', ')}` })
    .default('ollama'),
  // Model identifiers are configuration, never literals in application code. One per
  // provider, because the two name their models nothing alike.
  ANTHROPIC_MODEL: z.string().min(1, 'must not be empty').default('claude-sonnet-5'),
  OLLAMA_MODEL: z.string().min(1, 'must not be empty').default('llama3.1:8b'),
  // The loopback address rather than "localhost", which resolves to IPv6 first on
  // Windows and reaches a daemon that is listening on IPv4 only.
  OLLAMA_BASE_URL: z.url('must be an absolute URL').default('http://127.0.0.1:11434'),
  // Discovery loop bounds. Defaults live with the loop guard so there is one source of
  // truth for what a conservative limit is.
  DISCOVERY_MAX_STEPS: z.coerce
    .number({ error: 'must be a whole number of steps' })
    .int('must be a whole number of steps')
    .positive('must be greater than zero')
    .default(DEFAULT_LOOP_LIMITS.maxSteps),
  DISCOVERY_TIMEOUT_MS: timeoutMs.default(DEFAULT_LOOP_LIMITS.timeoutMs),
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
  // Safety policy. Every one is optional, and every default is the cautious one, so an
  // unset variable can only make this deployment refuse more. The values are validated
  // by the policy schema rather than here, so there is one definition of a valid policy.
  POLICY_ALLOWED_HOSTS: commaSeparated.optional(),
  POLICY_ALLOWED_SCHEMES: commaSeparated.optional(),
  POLICY_ALLOWED_ROUTES: commaSeparated.optional(),
  POLICY_ALLOWED_ACTIONS: commaSeparated.optional(),
  POLICY_RISK_SAFE: z.string().optional(),
  POLICY_RISK_RISKY: z.string().optional(),
  POLICY_RISK_IRREVERSIBLE: z.string().optional(),
});

type RawEnv = z.infer<typeof envSchema>;

/**
 * Builds the policy from the environment.
 *
 * Absent keys are dropped rather than passed as `undefined`, so the policy schema's own
 * defaults apply and there is one place that decides what "unset" means.
 */
function toPolicyConfig(env: RawEnv): PolicyConfig {
  const risk: Record<string, unknown> = {};
  if (env.POLICY_RISK_SAFE !== undefined) {
    risk['safe'] = env.POLICY_RISK_SAFE;
  }
  if (env.POLICY_RISK_RISKY !== undefined) {
    risk['risky'] = env.POLICY_RISK_RISKY;
  }
  if (env.POLICY_RISK_IRREVERSIBLE !== undefined) {
    risk['irreversible'] = env.POLICY_RISK_IRREVERSIBLE;
  }

  const raw: Record<string, unknown> = {};
  if (env.POLICY_ALLOWED_HOSTS !== undefined) {
    raw['allowedHosts'] = env.POLICY_ALLOWED_HOSTS;
  }
  if (env.POLICY_ALLOWED_SCHEMES !== undefined) {
    raw['allowedSchemes'] = env.POLICY_ALLOWED_SCHEMES;
  }
  if (env.POLICY_ALLOWED_ROUTES !== undefined) {
    raw['allowedRoutes'] = env.POLICY_ALLOWED_ROUTES;
  }
  if (env.POLICY_ALLOWED_ACTIONS !== undefined) {
    raw['allowedActions'] = env.POLICY_ALLOWED_ACTIONS;
  }
  if (Object.keys(risk).length > 0) {
    raw['riskPolicy'] = risk;
  }

  const parsed = policyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid safety policy:\n${formatIssues(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Resolves the model settings for the selected provider.
 *
 * Only the chosen provider's settings appear in the result, so a run cannot be handed a
 * base URL belonging to a provider it is not using, and `SafeConfig` cannot print one.
 */
function toLlmConfig(env: RawEnv): LlmConfig {
  if (env.LLM_PROVIDER === 'ollama') {
    return { provider: 'ollama', model: env.OLLAMA_MODEL, baseUrl: env.OLLAMA_BASE_URL };
  }
  return { provider: 'anthropic', model: env.ANTHROPIC_MODEL };
}

export interface AppConfig {
  readonly logLevel: LogLevel;
  /** Absolute path to the directory holding run evidence. */
  readonly evidenceDir: string;
  /** Absolute path to the directory holding capability artifacts. */
  readonly capabilitiesDir: string;
  /** Waiting budgets handed to a `ComputerSurface`. */
  readonly surfaceTimeouts: SurfaceTimeouts;
  /** What this deployment permits. The authority no artifact can overrule. */
  readonly policy: PolicyConfig;
  /** Which model boundary implementation a discovery run is given. */
  readonly llm: LlmConfig;
  /** The bounds on a discovery run. */
  readonly discovery: DiscoveryConfig;
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
  readonly policy: PolicyConfig;
  readonly llm: LlmConfig;
  readonly discovery: DiscoveryConfig;
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
    policy: toPolicyConfig(parsed.data),
    llm: toLlmConfig(parsed.data),
    discovery: {
      maxSteps: parsed.data.DISCOVERY_MAX_STEPS,
      timeoutMs: parsed.data.DISCOVERY_TIMEOUT_MS,
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
    policy: config.policy,
    llm: config.llm,
    discovery: config.discovery,
    anthropicApiKeyPresent: config.anthropicApiKey !== undefined,
  };
}
