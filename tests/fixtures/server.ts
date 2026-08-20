import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A static file server for the controlled demo application.
 *
 * The browser suites reach `tests/fixtures/` over `file://` and need nothing more. The
 * end-to-end suite and the documented demo do: both run the CLI as a real process against
 * a real origin, and a policy allowlist is expressed in hosts, so there has to be a host.
 * Serving the same directory over HTTP is the smallest thing that provides one.
 */

/** The port the README and the committed demo artifact both name. */
export const DEFAULT_FIXTURE_PORT = 3100;

const FIXTURE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface FixtureServer {
  /** Origin the server is listening on, with no trailing slash. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Resolves a request path to a file inside the fixture directory.
 *
 * Returns undefined for anything that escapes the directory. The server only ever holds
 * test fixtures, but a path traversal in a server that ships in the repository is worth
 * refusing on principle rather than on impact.
 */
function resolveFixturePath(requestPath: string): string | undefined {
  const decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  const relativePath = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = join(FIXTURE_DIR, relativePath);
  if (candidate !== FIXTURE_DIR && !candidate.startsWith(FIXTURE_DIR + sep)) {
    return undefined;
  }
  return candidate;
}

export async function startFixtureServer(
  port: number = DEFAULT_FIXTURE_PORT,
): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const path = resolveFixturePath(request.url ?? '/');
    if (path === undefined) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    void readFile(path).then(
      (body) => {
        const contentType = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
        response.writeHead(200, {
          'content-type': contentType,
          // The fixture is edited between runs and a cached copy would make a scenario
          // fail against a page that is no longer on disk.
          'cache-control': 'no-store',
        });
        response.end(body);
      },
      () => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
      },
    );
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    // Loopback only: this serves local test fixtures and has no business being reachable
    // from the network.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectListening);
      resolveListening();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a TCP port.');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: async (): Promise<void> => {
      await new Promise<void>((resolveClosed) => {
        server.close(() => {
          resolveClosed();
        });
      });
    },
  };
}

/**
 * Started directly by `npm run serve:fixtures`, so the documented demo is one command
 * rather than an instruction to find a static server.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const requested = Number(process.env['FIXTURE_PORT'] ?? DEFAULT_FIXTURE_PORT);
  const fixture = await startFixtureServer(requested);
  process.stdout.write(`Fixture Server Listening\n\n  ${fixture.url}/member-lookup.html\n\n`);
  const stop = (): void => {
    void fixture.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
