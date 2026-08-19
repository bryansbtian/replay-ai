import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import {
  deserializeCapabilityArtifact,
  FileArtifactStore,
  type CapabilityArtifact,
  type InputDefinition,
} from '../artifacts/index.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import { ReplayAiError } from '../errors.js';
import { FileEvidenceRecorder } from '../evidence/index.js';
import { createLogger } from '../logging/logger.js';
import { StaticPolicyEngine, summarizePolicy } from '../policy/index.js';
import { ReplayEngine, type InvocationInputs, type ReplayResult } from '../replay/index.js';
import { launchPlaywrightSession, PlaywrightSurface } from '../surfaces/playwright/index.js';

import { startHandoff, type HandoffContext } from './handoff.js';

/**
 * The `replay` command: run a saved capability against a real surface.
 *
 * This is a composition root, which is why it is the one place allowed to choose a
 * surface implementation. The engine it hands that surface to knows only the
 * `ComputerSurface` contract, so pointing this command at a different surface later is
 * a change to these few lines and to nothing else.
 */

const USAGE = `Usage:
  replay-ai replay --artifact <path> [--input name=value ...]
  replay-ai replay --capability <id>  [--input name=value ...]

Options:
  --artifact <path>    Path to a capability artifact JSON file
  --capability <id>    Id of an artifact in the configured capabilities directory
  --input name=value   An invocation input, repeatable
  --headed             Run the browser with a visible window
  --handoff            Pause for a person when the run cannot continue, and open the
                       operator interface. Implies a visible browser window.
`;

/** A CLI argument problem, reported the same way every other typed failure is. */
export class ReplayCommandError extends ReplayAiError {
  constructor(message: string) {
    super(message, 'REPLAY_COMMAND_INVALID');
  }
}

/** Where the artifact comes from. A union, so neither half needs a runtime check later. */
type ArtifactSource =
  { readonly kind: 'path'; readonly path: string } | { readonly kind: 'id'; readonly id: string };

interface ReplayArguments {
  readonly source: ArtifactSource;
  readonly inputs: ReadonlyMap<string, string>;
  readonly headless: boolean;
  /** Ask for a person rather than failing on a state the workflow cannot clear. */
  readonly handoff: boolean;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new ReplayCommandError(`${flag} requires a value.\n\n${USAGE}`);
  }
  return value;
}

export function parseReplayArguments(argv: readonly string[]): ReplayArguments {
  const inputs = new Map<string, string>();
  let artifactPath: string | undefined;
  let capabilityId: string | undefined;
  let headless = true;
  let handoff = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--artifact':
        index += 1;
        artifactPath = requireValue(argv, index, '--artifact');
        break;
      case '--capability':
        index += 1;
        capabilityId = requireValue(argv, index, '--capability');
        break;
      case '--input': {
        index += 1;
        const pair = requireValue(argv, index, '--input');
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new ReplayCommandError(`--input expects name=value, received "${pair}".`);
        }
        inputs.set(pair.slice(0, separator), pair.slice(separator + 1));
        break;
      }
      case '--headed':
        headless = false;
        break;
      case '--handoff':
        handoff = true;
        break;
      default:
        throw new ReplayCommandError(`Unknown option: ${String(flag)}\n\n${USAGE}`);
    }
  }

  if (artifactPath !== undefined && capabilityId !== undefined) {
    throw new ReplayCommandError(`--artifact and --capability are mutually exclusive.`);
  }

  if (artifactPath !== undefined) {
    return { source: { kind: 'path', path: artifactPath }, inputs, headless, handoff };
  }
  if (capabilityId !== undefined) {
    return { source: { kind: 'id', id: capabilityId }, inputs, headless, handoff };
  }
  throw new ReplayCommandError(`Either --artifact or --capability is required.\n\n${USAGE}`);
}

/**
 * Turns command-line strings into the declared input types.
 *
 * A shell has only strings, so this conversion has to happen somewhere. It happens here
 * rather than in the engine on purpose: the engine stays strict, so a programmatic
 * caller that passes the wrong type is told about it instead of having its mistake
 * quietly repaired.
 */
function coerceInput(definition: InputDefinition, raw: string): unknown {
  if (definition.type === 'string') {
    return raw;
  }
  if (definition.type === 'number') {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) {
      throw new ReplayCommandError(`Input "${definition.name}" must be a number.`);
    }
    return value;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new ReplayCommandError(`Input "${definition.name}" must be true or false.`);
}

export function buildInvocationInputs(
  artifact: CapabilityArtifact,
  supplied: ReadonlyMap<string, string>,
): InvocationInputs {
  const declared = new Map(artifact.inputs.map((input) => [input.name, input]));
  const invocation: Record<string, unknown> = {};

  for (const [name, raw] of supplied) {
    const definition = declared.get(name);
    if (definition === undefined) {
      // Passed through unchanged so the engine reports it, keeping one description of
      // what this capability accepts.
      invocation[name] = raw;
      continue;
    }
    invocation[name] = coerceInput(definition, raw);
  }
  return invocation;
}

async function loadArtifact(
  source: ArtifactSource,
  capabilitiesDir: string,
): Promise<CapabilityArtifact> {
  if (source.kind === 'path') {
    const path = resolve(source.path);
    return deserializeCapabilityArtifact(await readFile(path, 'utf8'), { source: path });
  }
  const store = new FileArtifactStore({ directory: capabilitiesDir });
  return await store.load(source.id);
}

export interface ReplayCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * A short human summary printed alongside the machine-readable result.
 *
 * Deliberately three lines: whoever just ran a replay wants to know what happened and
 * where to look, and neither of those should require piping the output through a JSON
 * tool. Nothing here can carry an invocation value.
 */
function summarize(result: ReplayResult, evidencePath: string): string {
  const lines = [
    '',
    'Replay Completed',
    '',
    `  Run ID:   ${result.replayId}`,
    `  Status:   ${describeStatus(result)}`,
    `  Evidence: ${evidencePath}`,
    '',
  ];
  return lines.join('\n');
}

function describeStatus(result: ReplayResult): string {
  if (result.status === 'success') {
    return 'Success';
  }
  if (result.status === 'businessOutcome') {
    return `Business Outcome (${result.code})`;
  }
  if (result.kind === 'policy') {
    return `Blocked By Policy (${result.code})`;
  }
  return `Failure (${result.code})`;
}

/** The evidence path, relative to the working directory when that reads better. */
function describePath(path: string): string {
  const local = relative(process.cwd(), path);
  if (local.startsWith('..')) {
    return path;
  }
  return local;
}

/**
 * Runs one replay and prints its structured result.
 *
 * The result is the whole of stdout: it names the capability, the steps that completed,
 * the conditions it recovered from, and either the declared outputs or what failed and
 * where. Invocation values never appear in it, and neither do log lines.
 */
export async function runReplayCommand(
  argv: readonly string[],
  deps: ReplayCommandDeps,
): Promise<ReplayResult> {
  const args = parseReplayArguments(argv);
  const config = loadConfig(deps.env);
  const artifact = await loadArtifact(args.source, config.capabilitiesDir);
  const inputs = buildInvocationInputs(artifact, args.inputs);

  // Run events go to stderr and the result goes to stdout, so `replay ... | jq` reads a
  // single JSON document. Interleaving them would make the result unparseable exactly
  // when a caller most wants to inspect it, which is on a failure.
  const logger = createLogger({
    level: config.logLevel,
    write: (line) => deps.stderr(`${line}\n`),
  });

  // One identifier for the run and its evidence directory: two would mean correlating
  // them by timestamp, which is exactly what a run id exists to avoid.
  const runId = randomUUID();
  const evidence = new FileEvidenceRecorder({ evidenceDir: config.evidenceDir, runId });
  await evidence.start({
    runId,
    capabilityId: artifact.id,
    capabilityVersion: artifact.version,
    capabilityName: artifact.name,
    inputNames: artifact.inputs.map((input) => input.name),
    policy: summarizePolicy(config.policy),
  });

  // A handoff means somebody operating the browser by hand, so the window has to be
  // visible. Asking for one implies a headed run rather than silently producing a session
  // nobody can reach.
  const headless = args.headless && !args.handoff;
  const session = await launchPlaywrightSession({ headless });

  let result: ReplayResult;
  let handoff: HandoffContext | undefined;
  try {
    const surface = new PlaywrightSurface({
      page: session.page,
      logger,
      timeouts: config.surfaceTimeouts,
    });

    if (args.handoff) {
      handoff = await startHandoff(
        {
          config,
          logger,
          evidence,
          surface,
          runId,
          automation: 'replay',
          subject: artifact.name,
        },
        deps,
      );
    }

    const engine = new ReplayEngine({
      surface,
      logger,
      policy: buildPolicy(config),
      evidence,
      timeouts: config.surfaceTimeouts,
      replayId: runId,
      ...(handoff !== undefined && { intervention: handoff.coordinator }),
    });
    result = await engine.run(artifact, inputs);
    handoff?.finish(result.status);
  } finally {
    // The browser closes only once the run is over. While a session is paused, under human
    // control, or resuming, the run is still inside `engine.run`, so nothing here runs and
    // the page a person is working in stays exactly where it is.
    await handoff?.stop();
    await session.close();
  }

  // Finalizing the manifest throws if it cannot be written, and the command lets that
  // reach the caller: a run directory that never says how the run ended is an
  // observability failure worth hearing about, not a warning to bury.
  await evidence.complete({
    status: result.status,
    ...outcomeDetail(result),
    durationMs: result.durationMs,
    completedSteps: result.completedSteps.length,
    recoveries: result.recoveries.length,
  });

  deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
  deps.stderr(summarize(result, describePath(evidence.directory)));
  for (const warning of evidence.warnings) {
    deps.stderr(`Evidence Warning: ${warning}\n`);
  }
  return result;
}

/** The policy in force for this command, built from configuration and nothing else. */
function buildPolicy(config: AppConfig): StaticPolicyEngine {
  return new StaticPolicyEngine(config.policy);
}

function outcomeDetail(result: ReplayResult): Record<string, string | string[]> {
  if (result.status === 'success') {
    return { outputNames: Object.keys(result.outputs) };
  }
  if (result.status === 'businessOutcome') {
    return { code: result.code };
  }
  const detail: Record<string, string> = { code: String(result.code), kind: result.kind };
  if (result.stepId !== undefined) {
    detail['stepId'] = result.stepId;
  }
  return detail;
}
