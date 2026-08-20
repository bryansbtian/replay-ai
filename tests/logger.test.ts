import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED, type LogFields } from '../src/logging/logger.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

interface Capture {
  readonly lines: string[];
  readonly records: () => Record<string, unknown>[];
}

function capture(): Capture & { write: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string): void => {
      lines.push(line);
    },
    records: (): Record<string, unknown>[] => {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function loggerWith(level: 'debug' | 'info' | 'warn' | 'error'): {
  log: ReturnType<typeof createLogger>;
  sink: Capture;
} {
  const sink = capture();
  const log = createLogger({ level, write: sink.write, now: () => FIXED_NOW });
  return { log, sink };
}

describe('createLogger', () => {
  it('writes one JSON record per call with timestamp, level and message', () => {
    const { log, sink } = loggerWith('info');

    log.info('run started', { runId: 'r-1', stepCount: 3 });

    expect(sink.lines).toHaveLength(1);
    expect(sink.records()[0]).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      message: 'run started',
      runId: 'r-1',
      stepCount: 3,
    });
  });

  it('drops records below the configured level', () => {
    const { log, sink } = loggerWith('warn');

    log.debug('noisy');
    log.info('also noisy');
    log.warn('kept');
    log.error('kept too');

    expect(sink.records().map((record) => record['level'])).toEqual(['warn', 'error']);
  });

  it('redacts secret-bearing field names, including nested ones', () => {
    const { log, sink } = loggerWith('info');

    const fields: LogFields = {
      apiKey: 'sk-live-value',
      request: { headers: { authorization: 'Bearer abc' }, url: 'https://example.test' },
      tokens: ['a', 'b'],
      safe: 'kept',
    };
    log.info('outbound request', fields);

    const line = sink.lines[0] ?? '';
    expect(line).not.toContain('sk-live-value');
    expect(line).not.toContain('Bearer abc');

    const record = sink.records()[0] ?? {};
    expect(record['apiKey']).toBe(REDACTED);
    expect(record['tokens']).toBe(REDACTED);
    expect(record['safe']).toBe('kept');
    expect(record['request']).toEqual({
      headers: { authorization: REDACTED },
      url: 'https://example.test',
    });
  });

  it('keeps boolean presence flags readable while redacting their string form', () => {
    const { log, sink } = loggerWith('info');

    log.info('config', { apiKeyPresent: true, apiKey: 'sk-live-value' });

    const record = sink.records()[0] ?? {};
    expect(record['apiKeyPresent']).toBe(true);
    expect(record['apiKey']).toBe(REDACTED);
  });

  it('serializes errors without dragging in a stack trace', () => {
    const { log, sink } = loggerWith('error');

    log.error('step failed', { cause: new TypeError('locator missing') });

    expect(sink.records()[0]?.['cause']).toEqual({
      name: 'TypeError',
      message: 'locator missing',
    });
  });

  it('merges child bindings into every record', () => {
    const { log, sink } = loggerWith('info');

    const child = log.child({ runId: 'r-2' }).child({ phase: 'replay' });
    child.info('step ok', { stepIndex: 0 });

    expect(sink.records()[0]).toMatchObject({
      runId: 'r-2',
      phase: 'replay',
      stepIndex: 0,
      message: 'step ok',
    });
  });

  it('truncates a self-referential field instead of recursing forever', () => {
    const { log, sink } = loggerWith('info');

    const cyclic: Record<string, unknown> = { label: 'root' };
    cyclic['self'] = cyclic;
    log.info('cyclic field', { cyclic });

    expect(sink.records()[0]?.['message']).toBe('cyclic field');
    expect(sink.lines[0] ?? '').toContain('[truncated]');
  });

  it('still emits a record when a field cannot be read or serialized', () => {
    const { log, sink } = loggerWith('info');

    const hostile = {
      get boom(): string {
        throw new TypeError('cannot read field');
      },
    };
    log.info('hostile field', { hostile });

    const record = sink.records()[0] ?? {};
    expect(record['message']).toBe('hostile field');
    expect(record['serializationError']).toBe('TypeError: cannot read field');
  });

  it('truncates beyond the depth guard instead of recursing without bound', () => {
    const { log, sink } = loggerWith('info');

    log.info('deep', { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } });

    expect(sink.lines[0] ?? '').not.toContain('too deep');
  });
});
