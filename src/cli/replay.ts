import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  deserializeCapabilityArtifact,
  FileArtifactStore,
  type CapabilityArtifact,
  type InputDefinition,
} from '../artifacts/index.js';
import { loadConfig } from '../config/index.js';
import { ReplayAiError } from '../errors.js';
import { createLogger } from '../logging/logger.js';
import { ReplayEngine, type InvocationInputs, type ReplayResult } from '../replay/index.js';
import { launchPlaywrightSession, PlaywrightSurface } from '../surfaces/playwright/index.js';

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
      default:
        throw new ReplayCommandError(`Unknown option: ${String(flag)}\n\n${USAGE}`);
    }
  }

  if (artifactPath !== undefined && capabilityId !== undefined) {
    throw new ReplayCommandError(`--artifact and --capability are mutually exclusive.`);
  }

  if (artifactPath !== undefined) {
    return { source: { kind: 'path', path: artifactPath }, inputs, headless };
  }
  if (capabilityId !== undefined) {
    return { source: { kind: 'id', id: capabilityId }, inputs, headless };
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
}

/**
 * Runs one replay and prints its structured result.
 *
 * The result is the whole output: it names the capability, the steps that completed,
 * and either the declared outputs or what failed and where. Invocation values never
 * appear in it.
 */
export async function runReplayCommand(
  argv: readonly string[],
  deps: ReplayCommandDeps,
): Promise<ReplayResult> {
  const args = parseReplayArguments(argv);
  const config = loadConfig(deps.env);
  const artifact = await loadArtifact(args.source, config.capabilitiesDir);
  const inputs = buildInvocationInputs(artifact, args.inputs);

  const logger = createLogger({
    level: config.logLevel,
    write: (line) => deps.stdout(`${line}\n`),
  });

  const session = await launchPlaywrightSession({ headless: args.headless });
  try {
    const surface = new PlaywrightSurface({
      page: session.page,
      logger,
      timeouts: config.surfaceTimeouts,
    });
    const engine = new ReplayEngine({ surface, logger, timeouts: config.surfaceTimeouts });
    const result = await engine.run(artifact, inputs);
    deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await session.close();
  }
}
