import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { SessionNotFoundError, type SessionRegistry } from '../handoff/index.js';
import type { Logger } from '../logging/logger.js';

import { renderOperatorPage } from './page.js';

/**
 * The local operator interface: one page, four routes, no framework.
 *
 * It is deliberately the smallest thing that makes control transfer real. It holds no
 * replay logic and makes no decisions: every route looks a session up in the registry and
 * calls one method on its coordinator, and the session state machine decides whether that
 * was allowed. A button that should not have been offered gets an error rather than an
 * invalid transition, which is what stops the UI from being the authorization.
 *
 * It binds to the loopback address. A handoff means somebody walking to the machine running
 * the browser, so there is nothing to gain from listening on every interface and a live
 * session to lose. Production operator access would need authentication, authorization, and
 * a way to reach a browser somebody else is running, none of which is here.
 */

/** Bound to loopback only. See the note above: this is not an access control decision. */
const HOST = '127.0.0.1';

export interface OperatorServerOptions {
  readonly registry: SessionRegistry;
  readonly logger: Logger;
  /** Zero asks the operating system for a free port, which is the usual case. */
  readonly port?: number;
  /** Where run evidence lives, so a screenshot can be served back to the page. */
  readonly evidenceDir: string;
}

export interface RunningOperatorServer {
  readonly url: string;
  /** The address for one session's page, printed by the command that paused. */
  operatorUrlFor(sessionId: string): string;
  close(): Promise<void>;
}

interface Route {
  readonly sessionId: string;
  readonly action: string;
}

/** `/operator/<id>` and `/operator/<id>/<action>`, and nothing else. */
function parse(pathname: string): Route | undefined {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'operator' || parts[1] === undefined) {
    return undefined;
  }
  return { sessionId: parts[1], action: parts[2] ?? '' };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
}

export async function startOperatorServer(
  options: OperatorServerOptions,
): Promise<RunningOperatorServer> {
  const { registry, logger } = options;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    const route = parse(url.pathname);

    if (route === undefined) {
      json(response, 404, { message: 'No such page.' });
      return;
    }

    const coordinator = registry.find(route.sessionId);
    if (coordinator === undefined) {
      // A page left open after its run finished is the common case, so it gets an answer
      // rather than a stack trace.
      const message = new SessionNotFoundError(route.sessionId).message;
      if (route.action === '') {
        html(
          response,
          404,
          `<!doctype html><title>Human Intervention</title><h1>Session Not Found</h1><p>${message}</p>`,
        );
        return;
      }
      json(response, 404, { message });
      return;
    }

    if (request.method === 'GET' && route.action === '') {
      html(response, 200, renderOperatorPage(coordinator.session.view()));
      return;
    }

    if (request.method === 'GET' && route.action === 'session') {
      json(response, 200, coordinator.session.view());
      return;
    }

    if (request.method === 'GET' && route.action === 'screenshot') {
      await serveScreenshot(options, coordinator.session.view(), response);
      return;
    }

    if (request.method !== 'POST') {
      json(response, 405, { message: 'That route expects a POST.' });
      return;
    }

    try {
      // The session state machine is the authority. Every one of these throws when the
      // transition is not allowed, which is what makes a duplicate Take Control or a resume
      // after abort impossible rather than merely unlikely.
      if (route.action === 'take-control') {
        await coordinator.takeControl();
      } else if (route.action === 'resume') {
        await coordinator.resume();
      } else if (route.action === 'abort') {
        await coordinator.abort('An operator ended the session.');
      } else {
        json(response, 404, { message: 'No such action.' });
        return;
      }
    } catch (error) {
      const message = describe(error);
      logger.warn('Operator Action Refused', {
        sessionId: route.sessionId,
        action: route.action,
        message,
      });
      json(response, 409, { message });
      return;
    }

    json(response, 200, coordinator.session.view());
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.error('Operator Request Failed', { message: describe(error) });
      json(response, 500, { message: 'The operator server could not answer that.' });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, HOST, resolve);
  });

  const base = `http://${HOST}:${String(listeningPort(server, options.port))}`;
  logger.info('Operator Interface Started', { url: base });

  return {
    url: base,
    operatorUrlFor(sessionId: string): string {
      return `${base}/operator/${sessionId}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Serves the capture taken when the run stopped.
 *
 * Read from the run's own evidence directory rather than held in memory, so the operator
 * page and the audit record show the same image and there is only one copy of it. The file
 * name comes from the recorder, never from the request, so a crafted URL cannot read
 * something else off the disk.
 */
async function serveScreenshot(
  options: OperatorServerOptions,
  session: { runId: string; intervention?: { screenshot?: string } },
  response: ServerResponse,
): Promise<void> {
  const file = session.intervention?.screenshot;
  if (file === undefined) {
    json(response, 404, { message: 'No screenshot was captured for this intervention.' });
    return;
  }

  const path = join(options.evidenceDir, 'runs', session.runId, 'screenshots', file);
  try {
    const data = await readFile(path);
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(data);
  } catch {
    json(response, 404, { message: 'That screenshot is no longer on disk.' });
  }
}

/** The port actually bound, which is the interesting one when zero was requested. */
function listeningPort(server: Server, requested: number | undefined): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    return address.port;
  }
  return requested ?? 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown failure.';
}
