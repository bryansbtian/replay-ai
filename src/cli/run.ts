import { loadConfig, toSafeConfig } from '../config/index.js';
import { ReplayAiError } from '../errors.js';
import { createLogger } from '../logging/logger.js';

import { runDiscoverCommand } from './discover.js';
import { runReplayCommand } from './replay.js';

/** Mirrors the `version` field of package.json; asserted by tests. */
export const CLI_VERSION = '0.1.0';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/**
 * A replay that ran correctly and hit an outcome the capability already knows about.
 * Distinct from both, because "no member matches that reference" is neither a working
 * automation's success nor a broken one's failure, and a script calling this needs to
 * be able to tell.
 */
export const EXIT_BUSINESS_OUTCOME = 2;
/**
 * The deployment's policy refused the run. Distinct from a failure, because nothing went
 * wrong: an operator seeing this changes a rule or approves an action, rather than
 * investigating a defect.
 */
export const EXIT_POLICY_BLOCKED = 3;
/**
 * A discovery run that needs a person: the model asked for one, or policy required an
 * approval nobody can give yet. Distinct from a failure because the run did not go wrong,
 * and distinct from a policy block because the answer is not "no" but "not without a
 * decision somebody has to make". Phase 9 is what gives it somewhere to go.
 */
export const EXIT_ESCALATION_REQUIRED = 4;

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE = `replay-ai ${CLI_VERSION}

Usage:
  replay-ai <command>

Commands:
  config     Validate the environment and print the resolved configuration
  discover   Work out how a goal is achieved in a live application, using a model
  replay     Replay a saved capability artifact against a real surface
  version    Print the CLI version
  help       Print this message

Discovery:
  replay-ai discover --goal "<what to achieve>" --target <url> [--headed]

Replay:
  replay-ai replay --artifact <path> [--input name=value ...]
  replay-ai replay --capability <id>  [--input name=value ...]

Exit codes:
  0  Success            2  Business Outcome      4  Escalation Required
  1  Failure            3  Blocked By Policy

Discovery uses a local Ollama model. Replay does not. Pass --capability-name on
discover to compile a successful run into a reusable capability artifact.
`;

function printConfig(deps: CliDeps): number {
  const config = loadConfig(deps.env);
  const logger = createLogger({
    level: config.logLevel,
    write: (line) => deps.stdout(`${line}\n`),
  });
  logger.info('configuration loaded', toSafeConfig(config));
  return EXIT_OK;
}

/** Maps a replay outcome onto an exit code, see `EXIT_BUSINESS_OUTCOME`. */
async function replayCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const result = await runReplayCommand(argv, deps);
  if (result.status === 'success') {
    return EXIT_OK;
  }
  if (result.status === 'businessOutcome') {
    return EXIT_BUSINESS_OUTCOME;
  }
  deps.stderr(`${result.code}: ${result.message}\n`);
  if (result.kind === 'policy') {
    return EXIT_POLICY_BLOCKED;
  }
  return EXIT_ERROR;
}

/** Maps a discovery outcome onto an exit code, see `EXIT_ESCALATION_REQUIRED`. */
async function discoverCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { discovery: result, compilation } = await runDiscoverCommand(argv, deps);
  if (result.status === 'success') {
    // A run that discovered the workflow and then failed to produce a usable capability
    // did not do what it was asked to do, so it does not report success.
    if (compilation !== undefined && compilation.status !== 'compiled') {
      deps.stderr(`${compilation.code}: ${compilation.message}\n`);
      return EXIT_ERROR;
    }
    return EXIT_OK;
  }
  if (result.status === 'escalation') {
    deps.stderr(`Escalation Required: ${result.reason}\n`);
    return EXIT_ESCALATION_REQUIRED;
  }
  deps.stderr(`${result.code}: ${result.message}\n`);
  if (result.kind === 'policy') {
    return EXIT_POLICY_BLOCKED;
  }
  return EXIT_ERROR;
}

/**
 * Runs one CLI invocation and returns the process exit code.
 *
 * All I/O is injected so the command surface is testable without spawning a process.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const command = argv[0] ?? 'help';

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        deps.stdout(USAGE);
        return EXIT_OK;
      case 'version':
      case '--version':
      case '-v':
        deps.stdout(`${CLI_VERSION}\n`);
        return EXIT_OK;
      case 'config':
        return printConfig(deps);
      case 'discover':
        return await discoverCommand(argv.slice(1), deps);
      case 'replay':
        return await replayCommand(argv.slice(1), deps);
      default:
        deps.stderr(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT_ERROR;
    }
  } catch (error) {
    if (error instanceof ReplayAiError) {
      deps.stderr(`${error.code}: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
}
