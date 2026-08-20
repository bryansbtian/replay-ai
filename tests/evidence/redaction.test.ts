import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/logging/logger.js';
import { redactRecord, sanitizeUrl, REDACTED, UNPARSEABLE_URL } from '../../src/redaction.js';

/**
 * The rules that decide what may be written down, and the guarantee that both writers
 * apply them.
 *
 * The last group is the important one: a secret scrubbed from a durable record and
 * printed to a terminal has not been scrubbed, so the logger is asserted against the
 * same cases as the recorder.
 */

const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-real-value',
  apiKey: 'ak-real-value',
  Authorization: 'Bearer real-token',
  Cookie: 'session=real-session',
  'Set-Cookie': 'session=real-session; HttpOnly',
  password: 'hunter2',
  accessToken: 'real-token',
  clientSecret: 'real-secret',
  sessionId: 'real-session',
  credentials: 'real-credentials',
};

describe('redacting a record', () => {
  it.each(Object.keys(SECRETS))('removes the value of %s', (key) => {
    const redacted = redactRecord(SECRETS);

    expect(redacted[key]).toBe(REDACTED);
  });

  it('leaves every value in the record scrubbed, not merely the first', () => {
    expect(JSON.stringify(redactRecord(SECRETS))).not.toMatch(/real|hunter2/);
  });

  it('keeps fields that carry no secret', () => {
    const redacted = redactRecord({ capabilityId: 'lookup-demo-member', durationMs: 182 });

    expect(redacted).toEqual({ capabilityId: 'lookup-demo-member', durationMs: 182 });
  });

  it('keeps a presence flag, which is the point of having one', () => {
    expect(redactRecord({ apiKeyPresent: true })).toEqual({
      apiKeyPresent: true,
    });
  });

  it('reaches into nested objects and arrays', () => {
    const redacted = redactRecord({
      outer: { inner: { token: 'real-token' } },
      list: [{ password: 'hunter2' }],
    });

    expect(JSON.stringify(redacted)).not.toMatch(/real-token|hunter2/);
  });

  it('drops the stack of an error, keeping what identifies it', () => {
    const redacted = redactRecord({ cause: new RangeError('index out of range') });

    expect(redacted['cause']).toEqual({ name: 'RangeError', message: 'index out of range' });
  });

  it('stops at a depth limit rather than following a cycle forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(JSON.stringify(redactRecord(cyclic))).toContain('[truncated]');
  });
});

describe('sanitizing a URL', () => {
  it('keeps the part that identifies the page', () => {
    expect(sanitizeUrl('https://demo.replay-ai.test/members/list')).toBe(
      'https://demo.replay-ai.test/members/list',
    );
  });

  it('removes every query value while keeping the names', () => {
    const safe = sanitizeUrl('https://demo.replay-ai.test/m?token=abc&memberId=12345&page=2');

    expect(safe).toContain('token=%5Bredacted%5D');
    expect(safe).toContain('memberId=%5Bredacted%5D');
    expect(safe).not.toContain('abc');
    expect(safe).not.toContain('12345');
  });

  it('drops the fragment, which routinely carries a token and never carries evidence', () => {
    expect(sanitizeUrl('https://demo.replay-ai.test/m#access_token=abc')).toBe(
      'https://demo.replay-ai.test/m',
    );
  });

  it('drops credentials embedded in the URL', () => {
    const safe = sanitizeUrl('https://operator:hunter2@demo.replay-ai.test/members');

    expect(safe).not.toContain('hunter2');
    expect(safe).not.toContain('operator');
  });

  it('says so when a URL cannot be parsed, rather than passing it through', () => {
    expect(sanitizeUrl('not a url')).toBe(UNPARSEABLE_URL);
  });
});

describe('the logger and the recorder agree', () => {
  it('applies the same rules to the same fields', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (line) => lines.push(line),
    });

    logger.info('configuration loaded', SECRETS);

    const logged = lines.join('');
    expect(logged).not.toMatch(/real|hunter2/);
    // The recorder writes the output of the same function the logger just used.
    expect(JSON.parse(logged) as Record<string, unknown>).toMatchObject(redactRecord(SECRETS));
  });
});
