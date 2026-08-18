import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CLI_VERSION, EXIT_ERROR, EXIT_OK, runCli, type CliDeps } from '../src/cli/run.js';

function harness(env: NodeJS.ProcessEnv = {}): {
  deps: CliDeps;
  out: () => string;
  err: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      env,
      stdout: (text: string): void => {
        stdout.push(text);
      },
      stderr: (text: string): void => {
        stderr.push(text);
      },
    },
    out: (): string => stdout.join(''),
    err: (): string => stderr.join(''),
  };
}

describe('runCli', () => {
  it('prints usage when invoked with no arguments', () => {
    const { deps, out } = harness();

    expect(runCli([], deps)).toBe(EXIT_OK);
    expect(out()).toContain('Usage:');
  });

  it('prints the version', () => {
    const { deps, out } = harness();

    expect(runCli(['version'], deps)).toBe(EXIT_OK);
    expect(out().trim()).toBe(CLI_VERSION);
  });

  it('reports an unknown command on stderr with a non-zero exit code', () => {
    const { deps, err } = harness();

    expect(runCli(['discover'], deps)).toBe(EXIT_ERROR);
    expect(err()).toContain('Unknown command: discover');
  });

  it('emits a structured record for the config command without the API key', () => {
    const { deps, out } = harness({ ANTHROPIC_API_KEY: 'sk-secret-value', LOG_LEVEL: 'info' });

    expect(runCli(['config'], deps)).toBe(EXIT_OK);

    const record = JSON.parse(out().trim()) as Record<string, unknown>;
    expect(record['message']).toBe('configuration loaded');
    expect(record['anthropicApiKeyPresent']).toBe(true);
    expect(out()).not.toContain('sk-secret-value');
  });

  it('turns invalid configuration into a coded error on stderr, not a crash', () => {
    const { deps, err, out } = harness({ LOG_LEVEL: 'verbose' });

    expect(runCli(['config'], deps)).toBe(EXIT_ERROR);
    expect(err()).toContain('CONFIG_INVALID');
    expect(err()).toContain('LOG_LEVEL');
    expect(out()).toBe('');
  });

  it('reports the same version as package.json', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

    expect(CLI_VERSION).toBe(manifest.version);
  });
});
