import { describe, expect, it } from 'vitest';

import { ModelError } from '../../src/llm/index.js';
import { OllamaClient, type FetchLike } from '../../src/llm/ollama/index.js';

/**
 * The local provider boundary.
 *
 * The HTTP call is faked and nothing else is, so every case here is about the one job
 * this class has: turn a runtime's answer into a `ModelResponse`, or turn its failure
 * into a `ModelError` with a code the rest of the system understands. No test in this
 * file reaches a network, and none needs a daemon to be running.
 */

const BASE_URL = 'http://127.0.0.1:11434';

function clientWith(fetchLike: FetchLike): OllamaClient {
  return new OllamaClient({ baseUrl: BASE_URL, model: 'test-model', fetch: fetchLike });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DECISION = '{"type":"complete","summary":"Done.","outputs":{}}';

function answering(content: string, extra: Record<string, unknown> = {}): FetchLike {
  return () =>
    Promise.resolve(
      jsonResponse({
        model: 'test-model',
        message: { role: 'assistant', content, ...extra },
        prompt_eval_count: 812,
        eval_count: 41,
      }),
    );
}

const REQUEST = { system: 'You choose one action.', instruction: 'Step 1.' };

describe('a successful call', () => {
  it('returns the text, the model, and what it cost', async () => {
    const response = await clientWith(answering(DECISION)).complete(REQUEST);

    expect(response.text).toBe(DECISION);
    expect(response.model).toBe('test-model');
    expect(response.inputTokens).toBe(812);
    expect(response.outputTokens).toBe(41);
  });

  it('asks for one answer, not a stream, and constrains it to JSON', async () => {
    let sent: Record<string, unknown> = {};
    const client = clientWith((_url, init) => {
      // The client always sends a serialized string; reading it as one keeps the
      // assertion honest about what actually went over the wire.
      const body = init.body as string;
      sent = JSON.parse(body) as Record<string, unknown>;
      return Promise.resolve(jsonResponse({ message: { content: DECISION } }));
    });

    await client.complete(REQUEST);

    expect(sent['stream']).toBe(false);
    expect(sent['think']).toBe(false);
    expect(sent['format']).toBe('json');
    expect(sent['model']).toBe('test-model');
    // The system prompt and the one turn, and nothing else: no transcript accumulates
    // inside the client.
    expect(sent['messages']).toEqual([
      { role: 'system', content: 'You choose one action.' },
      { role: 'user', content: 'Step 1.' },
    ]);
  });

  it('posts to the chat endpoint whether or not the base URL has a trailing slash', async () => {
    let seen = '';
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'test-model',
      fetch: (url) => {
        seen = url;
        return Promise.resolve(jsonResponse({ message: { content: DECISION } }));
      },
    });

    await client.complete(REQUEST);

    expect(seen).toBe('http://127.0.0.1:11434/api/chat');
  });
});

describe('reasoning content', () => {
  it('never leaves the client, so nothing downstream could persist it', async () => {
    const thinking = 'First I should consider whether the user is watching, then I will act.';
    const response = await clientWith(answering(DECISION, { thinking })).complete(REQUEST);

    // The only thing that crosses the boundary is the answer. A reasoning field beside it
    // is not read, so there is no path by which it reaches a trace, a log, or evidence.
    expect(response.text).toBe(DECISION);
    expect(JSON.stringify(response)).not.toContain('user is watching');
    expect(Object.keys(response).sort()).toEqual([
      'durationMs',
      'inputTokens',
      'model',
      'outputTokens',
      'text',
    ]);
  });
});

describe('a call that produced no answer', () => {
  it('reports an empty response rather than returning an empty decision', async () => {
    const client = clientWith(answering('   '));

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_EMPTY',
    });
  });

  it('reports an empty response when the runtime answered with no message at all', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse({ model: 'test-model' })));

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_EMPTY',
    });
  });

  it('reports the provider as unavailable when the body is not the expected envelope', async () => {
    const client = clientWith(() =>
      Promise.resolve(new Response('<html>proxy error</html>', { status: 200 })),
    );

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  });
});

describe('provider failures', () => {
  const cases: readonly { status: number; code: string; why: string }[] = [
    { status: 401, code: 'MODEL_AUTHENTICATION_FAILED', why: 'a credential was refused' },
    { status: 403, code: 'MODEL_AUTHENTICATION_FAILED', why: 'access was denied' },
    { status: 404, code: 'MODEL_REQUEST_REJECTED', why: 'the model was never pulled' },
    { status: 429, code: 'MODEL_RATE_LIMITED', why: 'the runtime asked us to slow down' },
    { status: 400, code: 'MODEL_REQUEST_REJECTED', why: 'the request itself was wrong' },
    { status: 500, code: 'MODEL_UNAVAILABLE', why: 'the runtime failed' },
    { status: 503, code: 'MODEL_UNAVAILABLE', why: 'the runtime was not ready' },
  ];

  for (const { status, code, why } of cases) {
    it(`maps ${status} onto ${code} because ${why}`, async () => {
      const client = clientWith(() => Promise.resolve(jsonResponse({ error: 'x' }, status)));

      await expect(client.complete(REQUEST)).rejects.toMatchObject({ code });
    });
  }

  it('maps a daemon that is not running onto an unavailable provider', async () => {
    const client = clientWith(() => Promise.reject(new TypeError('fetch failed')));

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  });

  it('maps an aborted request onto a timeout', async () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    const client = clientWith(() => Promise.reject(aborted));

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('never quotes the provider into the message, and keeps the original as the cause', async () => {
    const original = new Error('POST /api/chat failed with authorization: Bearer sk-secret');
    const client = clientWith(() => Promise.reject(original));

    const error = await clientWith(() => Promise.reject(original))
      .complete(REQUEST)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).not.toContain('sk-secret');
    // Still reachable for a debugger, and never rendered into anything that gets printed.
    expect((error as ModelError).cause).toBe(original);
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(ModelError);
  });
});
