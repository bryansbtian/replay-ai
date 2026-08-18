import type { AllowedScheme, PolicyConfig } from './config.js';

/**
 * Deciding whether a URL is one this deployment may visit.
 *
 * Every check here works on a parsed `URL`. Nothing does substring matching, because
 * `url.includes('localhost')` is satisfied by `https://localhost.attacker.example`, and
 * an allowlist that can be defeated by naming a subdomain is not an allowlist.
 */

/** Why a URL is not acceptable, in the order the checks run. */
export type UrlRejection =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'scheme'; readonly scheme: string }
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'route'; readonly path: string };

export type UrlVerdict =
  { readonly ok: true } | { readonly ok: false; readonly rejection: UrlRejection };

/**
 * A hostname, in the one form the allowlist compares.
 *
 * Lower-cased because hostnames are case-insensitive, and stripped of the trailing dot
 * that makes `example.com.` the same name as `example.com` to a resolver and a different
 * string to `===`.
 *
 * `localhost`, `127.0.0.1`, and `[::1]` stay distinct. They are the same machine and
 * three different names, and quietly treating one entry as permission for the others is
 * how an allowlist grows a hole nobody wrote down. A deployment that means the loopback
 * interface lists the forms it actually uses.
 */
function normalizeHost(hostname: string): string {
  const lowered = hostname.toLowerCase();
  if (lowered.endsWith('.')) {
    return lowered.slice(0, -1);
  }
  return lowered;
}

/** An allowlist entry, split into the name and the optional port it pins. */
function normalizeEntry(entry: string): { host: string; port: string } {
  const separator = entry.lastIndexOf(':');
  if (separator === -1) {
    return { host: normalizeHost(entry), port: '' };
  }
  return {
    host: normalizeHost(entry.slice(0, separator)),
    port: entry.slice(separator + 1),
  };
}

/**
 * An entry without a port matches the host on any port, and an entry with one matches
 * only that port. Naming a port is how a deployment says "the dev server, not whatever
 * else is listening on this machine".
 */
function hostMatches(url: URL, entry: string): boolean {
  const wanted = normalizeEntry(entry);
  if (normalizeHost(url.hostname) !== wanted.host) {
    return false;
  }
  if (wanted.port === '') {
    return true;
  }
  return url.port === wanted.port;
}

/**
 * Prefix matching on segment boundaries, so `/members` covers `/members` and
 * `/members/42` and does not cover `/membersecret`. A prefix that silently spanned a
 * segment boundary would let one allowed route authorize a neighbouring one.
 */
function routeMatches(path: string, prefix: string): boolean {
  if (path === prefix) {
    return true;
  }
  if (prefix.endsWith('/')) {
    return path.startsWith(prefix);
  }
  return path.startsWith(`${prefix}/`);
}

function isAllowedScheme(scheme: string, allowed: readonly AllowedScheme[]): boolean {
  // `URL.protocol` keeps the colon; the configured values do not.
  const withoutColon = scheme.replace(/:$/, '');
  return allowed.some((candidate) => candidate === withoutColon);
}

/**
 * Parses a URL and checks it against the allowlist.
 *
 * The order is deliberate: an unparseable URL cannot be checked at all, a scheme decides
 * whether the rest of the URL even means what it looks like, and only then are host and
 * path worth comparing.
 */
export function evaluateUrl(url: string, config: PolicyConfig): UrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, rejection: { kind: 'invalid' } };
  }

  if (!isAllowedScheme(parsed.protocol, config.allowedSchemes)) {
    return { ok: false, rejection: { kind: 'scheme', scheme: parsed.protocol.replace(/:$/, '') } };
  }

  if (parsed.hostname !== '') {
    const permitted = config.allowedHosts.some((entry) => hostMatches(parsed, entry));
    if (!permitted) {
      return { ok: false, rejection: { kind: 'host', host: parsed.host } };
    }
    if (config.allowedRoutes.length === 0) {
      return { ok: true };
    }
  }

  // A scheme with no host, such as `file`, has no domain allowlist protecting it, so the
  // route list is the only control left and an empty one denies rather than permits.
  if (config.allowedRoutes.length === 0) {
    return { ok: false, rejection: { kind: 'route', path: parsed.pathname } };
  }

  const permitted = config.allowedRoutes.some((prefix) => routeMatches(parsed.pathname, prefix));
  if (!permitted) {
    return { ok: false, rejection: { kind: 'route', path: parsed.pathname } };
  }
  return { ok: true };
}
