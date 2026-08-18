import { loadConfig, toSafeConfig } from '../config/index.js';
import { ReplayAiError } from '../errors.js';
import { createLogger } from '../logging/logger.js';

/** Mirrors the `version` field of package.json; asserted by tests. */
export const CLI_VERSION = '0.1.0';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

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
  version    Print the CLI version
  help       Print this message

Discovery and replay commands arrive in later phases.
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

/**
 * Runs one CLI invocation and returns the process exit code.
 *
 * All I/O is injected so the command surface is testable without spawning a process.
 */
export function runCli(argv: readonly string[], deps: CliDeps): number {
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
