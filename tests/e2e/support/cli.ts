import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Running the real CLI as a real process.
 *
 * The Vitest suites drive the engines in memory, which is what makes them fast enough to
 * assert on every branch. Nothing there proves that the published command works: that
 * argument parsing, configuration loading, artifact loading from disk, evidence writing,
 * and the exit code all line up when a person types the command a reviewer is handed.
 * That is what this file exists for, and it is why these specs spawn a process rather
 * than importing `runCli`.
 */

/** Exit codes, mirroring `src/cli/run.ts`. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_BUSINESS_OUTCOME = 2;
export const EXIT_POLICY_BLOCKED = 3;

const CLI_ENTRY = resolve('src/cli/main.ts');

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  /** Added to a minimal environment. Nothing is inherited that could carry a credential. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The environment a spawned run starts from.
 *
 * Deliberately built up rather than spread from `process.env`: a run that inherited the
 * developer's environment could pick up a `LLM_PROVIDER` or `OLLAMA_BASE_URL` and
 * quietly prove something other than what the spec claims. PATH and the Windows system
 * variables are the only things carried over, because Node and Chromium need them.
 */
function baseEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'windir',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  return inherited;
}

export async function runCliProcess(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const env = { ...baseEnvironment(), ...options.env };

  return await new Promise<CliResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', rejectResult);
    child.once('close', (code) => {
      resolveResult({ code: code ?? EXIT_ERROR, stdout, stderr });
    });
  });
}

/** The JSON document the CLI writes to stdout, parsed. */
export function resultOf(run: CliResult): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

export interface Workspace {
  readonly evidenceDir: string;
  readonly capabilitiesDir: string;
  /** Environment pointing a run at this workspace rather than at the repository. */
  env(): Record<string, string>;
}

/**
 * A throwaway evidence and capabilities directory for one spec file.
 *
 * Specs must not write into the repository's committed `evidence/`: that directory holds
 * reviewed submission evidence, and a test run appending to it would make the committed
 * set impossible to reason about.
 */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'replay-ai-e2e-'));
  const evidenceDir = join(root, 'evidence');
  const capabilitiesDir = join(root, 'capabilities');

  return {
    evidenceDir,
    capabilitiesDir,
    env: (): Record<string, string> => {
      return { EVIDENCE_DIR: evidenceDir, CAPABILITIES_DIR: capabilitiesDir };
    },
  };
}

/**
 * Rewrites a committed example artifact to point at the served fixture and writes it into
 * the workspace.
 *
 * The examples name a domain that does not exist, because an example is documentation and
 * should not imply that somebody's machine hosts it. A spec needs one that resolves, so it
 * substitutes the origin and changes nothing else.
 */
export async function installArtifact(
  workspace: Workspace,
  examplePath: string,
  fixtureUrl: string,
): Promise<string> {
  const raw = await readFile(examplePath, 'utf8');
  const artifact = JSON.parse(raw) as {
    id: string;
    application: { entryPoint: string };
    steps: { type: string; url?: string }[];
  };

  artifact.application.entryPoint = fixtureUrl;
  for (const step of artifact.steps) {
    if (step.type === 'navigate') {
      step.url = fixtureUrl;
    }
  }

  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace.capabilitiesDir, { recursive: true });
  const target = join(workspace.capabilitiesDir, `${artifact.id}.json`);
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return target;
}

export interface RunEvidence {
  readonly metadata: Record<string, unknown>;
  readonly events: Record<string, unknown>[];
}

/** Reads the evidence directory a run wrote, by its run id. */
export async function readEvidence(workspace: Workspace, runId: string): Promise<RunEvidence> {
  const directory = join(workspace.evidenceDir, 'runs', runId);
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
  const events = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { metadata, events };
}

/** Every run id the workspace has evidence for. */
export async function recordedRunIds(workspace: Workspace): Promise<string[]> {
  return await readdir(join(workspace.evidenceDir, 'runs'));
}
