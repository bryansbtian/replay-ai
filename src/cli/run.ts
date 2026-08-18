import { loadConfig, toSafeConfig } from '../config/index.js';
import { ReplayAiError } from '../errors.js';
import { createLogger } from '../logging/logger.js';

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
  replay     Replay a saved capability artifact against a real surface
  version    Print the CLI version
  help       Print this message

Replay:
  replay-ai replay --artifact <path> [--input name=value ...]
  replay-ai replay --capability <id>  [--input name=value ...]

Discovery arrives in a later phase.
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
