/**
 * The one set of redaction rules in the system.
 *
 * It lives at the root, next to the shared error base, because two very different
 * consumers must agree on it: the developer log that streams while a run happens, and
 * the durable evidence a run leaves behind. Redacting a secret in evidence while the
 * logger prints it to a terminal that gets pasted into a ticket is not redaction, so the
 * rules are stated once and both sides import them.
 *
 * This is not a data-loss-prevention engine. It is a small, reviewable set of rules that
 * covers the values this system actually handles: credentials in configuration, tokens
 * in headers and query strings, and values a caller supplied at invocation time.
 */

export const REDACTED = '[redacted]';

/**
 * Field names whose values are never persisted or printed.
 *
 * Matched as a substring, case-insensitively, so `apiKey`, `ANTHROPIC_API_KEY`,
 * `set-cookie`, and `authorizationHeader` are all covered by one rule. A denylist of
 * names is weaker than an allowlist of safe fields, and it is what a general-purpose
 * logger can enforce; the layers that know their own data (evidence, policy contexts)
 * do not rely on it alone and simply never carry a sensitive value in the first place.
 */
const SENSITIVE_KEY_PATTERN =
  /(key|token|secret|password|passwd|credential|auth|cookie|session|bearer)/i;

/**
 * A field is redacted when its name looks secret-bearing and its value could carry
 * content. Booleans are exempt: a presence flag such as `anthropicApiKeyPresent` is
 * exactly the kind of field this exists to make loggable.
 */
export function isSensitiveField(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return false;
  }
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Depth guard so a deeply nested or self-referential field cannot stall a writer. */
const MAX_DEPTH = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (value instanceof Error) {
    // The stack is deliberately dropped: it is noise in a record and a way for an
    // internal path to reach somewhere it was never reviewed for.
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return redactRecord(value, depth);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/** Returns a copy of `fields` with every secret-bearing value replaced. */
export function redactRecord(
  fields: Readonly<Record<string, unknown>>,
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveField(key, value)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(value, depth + 1);
  }
  return result;
}

/** What a URL is reduced to when it cannot be parsed at all. */
export const UNPARSEABLE_URL = '[unparseable url]';

/**
 * Reduces a URL to the part that is safe to keep.
 *
 * Query values are removed wholesale rather than matched against a list of suspicious
 * parameter names. A denylist gets `?token=` and misses `?acct=`, and in the kind of
 * application this project targets the second is the one that matters. Parameter names
 * survive, so evidence still shows the shape of the request; the values do not, which is
 * the same rule that keeps invocation inputs out of a record.
 *
 * The fragment is dropped entirely, because it routinely carries tokens and never
 * carries anything an audit needs. Userinfo is dropped for the obvious reason.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNPARSEABLE_URL;
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';

  const names = [...parsed.searchParams.keys()];
  for (const name of names) {
    parsed.searchParams.set(name, REDACTED);
  }

  return parsed.toString();
}
