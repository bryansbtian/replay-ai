import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { deserializeCapabilityArtifact, parseCapabilityArtifact } from '../src/artifacts/index.js';
import {
  buildInvocationInputs,
  parseReplayArguments,
  ReplayCommandError,
} from '../src/cli/replay.js';
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
  it('prints usage when invoked with no arguments', async () => {
    const { deps, out } = harness();

    expect(await runCli([], deps)).toBe(EXIT_OK);
    expect(out()).toContain('Usage:');
  });

  it('prints the version', async () => {
    const { deps, out } = harness();

    expect(await runCli(['version'], deps)).toBe(EXIT_OK);
    expect(out().trim()).toBe(CLI_VERSION);
  });

  it('reports an unknown command on stderr with a non-zero exit code', async () => {
    const { deps, err } = harness();

    expect(await runCli(['compile'], deps)).toBe(EXIT_ERROR);
    expect(err()).toContain('Unknown command: compile');
  });

  it('routes discover to its own command and refuses an invocation with no goal', async () => {
    // Phase 7 turned `discover` from an unknown command into a real one. It fails here on
    // its own argument validation rather than on the command lookup, and it fails before
    // reaching a model, so this case needs no provider of any kind.
    const { deps, err } = harness();

    expect(await runCli(['discover', '--target', 'http://127.0.0.1:3000'], deps)).toBe(EXIT_ERROR);
    expect(err()).toContain('--goal is required');
  });

  it('emits a structured record for the config command with the local runtime', async () => {
    const { deps, out } = harness({ LOG_LEVEL: 'info', OLLAMA_MODEL: 'gemma3:27b' });

    expect(await runCli(['config'], deps)).toBe(EXIT_OK);

    const record = JSON.parse(out().trim()) as Record<string, unknown>;
    expect(record['message']).toBe('configuration loaded');
    expect(record['llm']).toEqual({
      provider: 'ollama',
      model: 'gemma3:27b',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(out()).not.toMatch(/sk-|apiKey|secret/i);
  });

  it('turns invalid configuration into a coded error on stderr, not a crash', async () => {
    const { deps, err, out } = harness({ LOG_LEVEL: 'verbose' });

    expect(await runCli(['config'], deps)).toBe(EXIT_ERROR);
    expect(err()).toContain('CONFIG_INVALID');
    expect(err()).toContain('LOG_LEVEL');
    expect(out()).toBe('');
  });

  it('lists the replay command in its usage', async () => {
    const { deps, out } = harness();

    await runCli(['help'], deps);

    expect(out()).toContain('replay');
    expect(out()).toContain('--input name=value');
  });

  it('reports a missing artifact path without a stack trace', async () => {
    const { deps, err } = harness();

    expect(await runCli(['replay', '--artifact', 'capabilities/does-not-exist.json'], deps)).toBe(
      EXIT_ERROR,
    );
    expect(err()).toContain('REPLAY_COMMAND_INVALID');
    expect(err()).toContain('Artifact not found');
    expect(err()).not.toContain('at async');
  });

  it('reports the same version as package.json', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

    expect(CLI_VERSION).toBe(manifest.version);
  });
});

describe('replay command arguments', () => {
  it('reads an artifact path and repeated inputs', () => {
    const args = parseReplayArguments([
      '--artifact',
      'tests/fixtures/capabilities/lookup-demo-member.json',
      '--input',
      'memberId=12345',
      '--input',
      'region=eu',
    ]);

    expect(args.source).toEqual({
      kind: 'path',
      path: 'tests/fixtures/capabilities/lookup-demo-member.json',
    });
    expect([...args.inputs]).toEqual([
      ['memberId', '12345'],
      ['region', 'eu'],
    ]);
    expect(args.headless).toBe(true);
  });

  it('opens a visible browser when --headed is supplied', () => {
    const args = parseReplayArguments(['--artifact', 'a.json', '--headed']);

    expect(args.headless).toBe(false);
  });

  it('reads a capability id', () => {
    expect(parseReplayArguments(['--capability', 'lookup-demo-member']).source).toEqual({
      kind: 'id',
      id: 'lookup-demo-member',
    });
  });

  it('refuses an artifact path and a capability id together', () => {
    expect(() => parseReplayArguments(['--artifact', 'a.json', '--capability', 'b'])).toThrow(
      ReplayCommandError,
    );
  });

  it('refuses an input that is not name=value', () => {
    expect(() => parseReplayArguments(['--artifact', 'a.json', '--input', 'memberId'])).toThrow(
      ReplayCommandError,
    );
  });

  it('refuses a flag with no value', () => {
    expect(() => parseReplayArguments(['--artifact', '--input', 'a=b'])).toThrow(
      ReplayCommandError,
    );
  });

  it('refuses an option it does not know', () => {
    expect(() => parseReplayArguments(['--artifact', 'a.json', '--retry'])).toThrow(
      ReplayCommandError,
    );
  });

  it('accepts a value containing an equals sign', () => {
    const args = parseReplayArguments(['--artifact', 'a.json', '--input', 'note=a=b']);

    expect(args.inputs.get('note')).toBe('a=b');
  });
});

describe('replay command inputs', () => {
  const artifact = deserializeCapabilityArtifact(
    readFileSync('tests/fixtures/capabilities/lookup-demo-member.json', 'utf8'),
  );

  it('keeps a declared string input as text', () => {
    expect(buildInvocationInputs(artifact, new Map([['memberId', '12345']]))).toEqual({
      memberId: '12345',
    });
  });

  it('converts a declared number input, because a shell only has strings', () => {
    const numeric = parseCapabilityArtifact({
      ...artifact,
      inputs: [{ name: 'memberId', type: 'number', required: true, description: 'The member id.' }],
    });

    expect(buildInvocationInputs(numeric, new Map([['memberId', '12345']]))).toEqual({
      memberId: 12345,
    });
  });

  it('passes an undeclared input through so the engine reports it', () => {
    expect(buildInvocationInputs(artifact, new Map([['tenant', 'acme']]))).toEqual({
      tenant: 'acme',
    });
  });
});
