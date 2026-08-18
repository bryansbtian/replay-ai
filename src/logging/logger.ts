/**
 * Small structured logger.
 *
 * One JSON object per line, with a timestamp, a level, a message and arbitrary
 * structured fields. Field values whose key looks secret-bearing are redacted so
 * that a caller cannot leak an API key by logging a config object by accident.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = '[redacted]';

const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|credential|auth|cookie|session)/i;

/** Depth guard so a deeply nested or self-referential field cannot stall logging. */
const MAX_DEPTH = 6;

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

/**
 * A field is redacted when its name looks secret-bearing and its value could carry
 * content. Booleans are exempt: a presence flag such as `anthropicApiKeyPresent`
 * is exactly the kind of field this logger exists to make loggable.
 */
function isRedactable(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return sanitizeObject(value, depth);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return 'unknown serialization failure';
}

function sanitizeObject(value: LogFields, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isRedactable(key, nested)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = sanitize(nested, depth + 1);
  }
  return result;
}

interface RecordHeader {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
}

function render(header: RecordHeader, fields: LogFields): string {
  try {
    return JSON.stringify({ ...header, ...sanitizeObject(fields, 0) });
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
