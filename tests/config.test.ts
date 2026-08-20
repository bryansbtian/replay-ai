import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, toSafeConfig } from '../src/config/index.js';
import { ConfigurationError } from '../src/errors.js';
import { DEFAULT_SURFACE_TIMEOUTS } from '../src/surfaces/index.js';

const CWD = '/workspace';

/**
 * What resolving a path against `CWD` produces on the platform running the suite.
 *
 * `loadConfig` resolves relative paths with `node:path`, so the answer is `/workspace/x`
 * on a POSIX machine and `C:\workspace\x` on Windows, where a rooted path also acquires
 * the current drive. Asserting the literal POSIX string would be asserting the platform
 * rather than the behaviour, which is that a relative directory is resolved against the
 * supplied working directory and an absolute one is left alone.
 */
function underCwd(...segments: readonly string[]): string {
  return resolve(CWD, ...segments);
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('loadConfig', () => {
  it('loads with defaults when only optional variables are absent', () => {
    const config = loadConfig({}, { cwd: CWD });

    expect(config.logLevel).toBe('info');
    expect(config.evidenceDir).toBe(underCwd('evidence'));
    expect(config.capabilitiesDir).toBe(underCwd('capabilities'));
    expect(config.llm).toEqual({
      provider: 'ollama',
      model: 'gemma3:27b',
      baseUrl: 'http://127.0.0.1:11434',
    });
  });

  it('reads supplied values and keeps absolute paths as given', () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'debug',
        EVIDENCE_DIR: '/var/run/evidence',
        CAPABILITIES_DIR: 'artifacts/caps',
      },
      { cwd: CWD },
    );

    expect(config.logLevel).toBe('debug');
    // Already absolute on every platform, so it is kept exactly as given rather than
    // resolved against the working directory.
    expect(config.evidenceDir).toBe('/var/run/evidence');
    expect(config.capabilitiesDir).toBe(underCwd('artifacts', 'caps'));
  });

  it('rejects an unknown log level and names the offending variable', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' }, { cwd: CWD })).toThrow(ConfigurationError);
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' }, { cwd: CWD })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an empty directory value instead of silently using the default', () => {
    expect(() => loadConfig({ EVIDENCE_DIR: '' }, { cwd: CWD })).toThrow(/EVIDENCE_DIR/);
  });

  it('defaults the surface timeouts so a surface can be built without configuration', () => {
    const config = loadConfig({}, { cwd: CWD });

    expect(config.surfaceTimeouts).toEqual(DEFAULT_SURFACE_TIMEOUTS);
  });

  it('reads surface timeout overrides from the environment', () => {
    const config = loadConfig(
      {
        SURFACE_NAVIGATION_TIMEOUT_MS: '20000',
        SURFACE_LOCATOR_TIMEOUT_MS: '2500',
        SURFACE_ACTION_TIMEOUT_MS: '7000',
      },
      { cwd: CWD },
    );

    expect(config.surfaceTimeouts).toEqual({
      navigationMs: 20_000,
      locatorMs: 2_500,
      actionMs: 7_000,
    });
  });

  it('rejects a surface timeout that is not a positive whole number', () => {
    expect(() => loadConfig({ SURFACE_LOCATOR_TIMEOUT_MS: 'soon' }, { cwd: CWD })).toThrow(
      /SURFACE_LOCATOR_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ SURFACE_ACTION_TIMEOUT_MS: '0' }, { cwd: CWD })).toThrow(
      /SURFACE_ACTION_TIMEOUT_MS/,
    );
  });

  it('rejects an unknown model provider rather than calling one that is not shipped', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' }, { cwd: CWD })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' }, { cwd: CWD })).toThrow(/LLM_PROVIDER/);
  });

  it('reads a local model override from the environment', () => {
    const config = loadConfig(
      {
        OLLAMA_MODEL: 'gemma3:27b',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      },
      { cwd: CWD },
    );

    expect(config.llm).toEqual({
      provider: 'ollama',
      model: 'gemma3:27b',
      baseUrl: 'http://127.0.0.1:11434',
    });
  });

  it('does not echo invalid values in the error message', () => {
    const secretish = 'sk-should-never-appear';
    const error = captureError(() => loadConfig({ LOG_LEVEL: secretish }, { cwd: CWD }));

    expect(error).toBeInstanceOf(ConfigurationError);
    if (error instanceof ConfigurationError) {
      expect(error.message).toContain('LOG_LEVEL');
      expect(error.message).not.toContain(secretish);
    }
  });

  it('carries a stable error code for programmatic handling', () => {
    const error = captureError(() => loadConfig({ LOG_LEVEL: 'nope' }, { cwd: CWD }));

    expect(error).toBeInstanceOf(ConfigurationError);
    if (error instanceof ConfigurationError) {
      expect(error.code).toBe('CONFIG_INVALID');
    }
  });
});

describe('toSafeConfig', () => {
  it('reports the local runtime without inventing a credential field', () => {
    const config = loadConfig({ OLLAMA_MODEL: 'gemma3:27b' }, { cwd: CWD });
    const safe = toSafeConfig(config);

    expect(safe.llm).toEqual({
      provider: 'ollama',
      model: 'gemma3:27b',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(Object.keys(safe).join(',')).not.toMatch(/key|secret|token/i);
  });
});
