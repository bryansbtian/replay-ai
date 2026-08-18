import { redactRecord, REDACTED } from '../redaction.js';

/**
 * Small structured logger.
 *
 * One JSON object per line, with a timestamp, a level, a message and arbitrary
 * structured fields. Field values whose key looks secret-bearing are redacted so
 * that a caller cannot leak an API key by logging a config object by accident.
 *
 * The redaction rules come from `src/redaction.ts` rather than living here, because the
 * evidence recorder has to apply exactly the same ones. A secret that is scrubbed from a
 * durable record and printed to a terminal has not been scrubbed.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export { REDACTED };

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every record it writes. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Sink for finished lines. Defaults to stdout; injected in tests. */
  readonly write?: (line: string) => void;
  /** Clock, injected in tests to keep output deterministic. */
  readonly now?: () => Date;
  readonly bindings?: LogFields;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return 'unknown serialization failure';
}

interface RecordHeader {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
}

function render(header: RecordHeader, fields: LogFields): string {
  try {
    return JSON.stringify({ ...header, ...redactRecord(fields) });
  } catch (cause) {
    // A hostile field (throwing getter, unsupported value) must never drop the
    // record or take down the caller. Emit the header plus what went wrong.
    return JSON.stringify({ ...header, serializationError: describeCause(cause) });
  }
}

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? writeToStdout;
  const now = options.now ?? ((): Date => new Date());
  const bindings = options.bindings ?? {};
  const threshold = LEVEL_RANK[options.level];

  function log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }
    const header: RecordHeader = { timestamp: now().toISOString(), level, message };
    write(render(header, { ...bindings, ...fields }));
  }

  return {
    debug(message, fields): void {
      log('debug', message, fields);
    },
    info(message, fields): void {
      log('info', message, fields);
    },
    warn(message, fields): void {
      log('warn', message, fields);
    },
    error(message, fields): void {
      log('error', message, fields);
    },
    child(childBindings): Logger {
      return createLogger({ ...options, bindings: { ...bindings, ...childBindings } });
    },
  };
}
