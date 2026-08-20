import { createServer, type Server } from 'node:http';

/**
 * A scripted stand-in for the model, speaking the local provider's chat endpoint.
 *
 * The end-to-end suite has to exercise the real discovery command: real argument parsing,
 * a real browser, real policy checks, real compilation, a real verification replay, and a
 * real artifact written to disk. The only thing it must not do is call a provider, because
 * CI has to be deterministic and free.
 *
 * Scripting the answers rather than the client is what makes that honest. Discovery still
 * builds a prompt, still sends it over HTTP, still parses and validates what comes back,
 * and still rejects an answer outside the decision vocabulary. What is fixed is only which
 * valid decision comes next.
 */

export interface StubModel {
  readonly baseUrl: string;
  /** One entry per call the run made, in order. */
  readonly requests: () => readonly string[];
  close(): Promise<void>;
}

/**
 * Serves the scripted decisions in order.
 *
 * Once the script runs out the stub keeps answering with the last decision, which is
 * always a terminal one in these specs. That is kinder to debug than a connection error:
 * a run that took an unexpected extra turn fails on the assertion that describes the
 * problem rather than on a transport failure that does not.
 */
export async function startStubModel(decisions: readonly unknown[]): Promise<StubModel> {
  if (decisions.length === 0) {
    throw new Error('A stub model needs at least one decision.');
  }

  const seen: string[] = [];
  let index = 0;

  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      seen.push(body);
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'stub-model',
          message: { content: JSON.stringify(decision) },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      );
    });
  });

  await new Promise<void>((resolveListening) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListening();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Stub model did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests: (): readonly string[] => {
      return seen;
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolveClosed) => {
        server.close(() => {
          resolveClosed();
        });
      });
    },
  };
}
