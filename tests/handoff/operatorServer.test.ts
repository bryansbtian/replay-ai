import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InterventionContext } from '../../src/execution/index.js';
import { AutomationSession, HandoffCoordinator, SessionRegistry } from '../../src/handoff/index.js';
import { startOperatorServer, type RunningOperatorServer } from '../../src/operator/index.js';
import { RecordingEvidence, silentLogger } from '../discovery/support/fakes.js';
import { FakeSurface } from '../replay/support/fakeSurface.js';

/**
 * The operator interface, over real HTTP.
 *
 * The cases that matter are the refusals. A page is a hint about what is possible; the
 * server has to be the thing that decides, because a stale tab, a double click, and a
 * curl command all reach the same routes.
 */

const CONTEXT: InterventionContext = {
  source: 'replay',
  reason: 'UNRECOVERABLE_FAILURE',
  subject: 'Lookup Member Balance',
  stepId: 'await-member-summary',
  code: 'REPLAY_WAIT_TIMEOUT',
  detail: 'The member summary never appeared.',
};

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let server: RunningOperatorServer;
let registry: SessionRegistry;
let coordinator: HandoffCoordinator;
let session: AutomationSession;

beforeEach(async () => {
  registry = new SessionRegistry();
  session = new AutomationSession({
    id: 'session-1',
    runId: '11111111-1111-4111-8111-111111111111',
    automation: 'replay',
    subject: 'Lookup Member Balance',
  });
  coordinator = new HandoffCoordinator({
    session,
    surface: new FakeSurface({ url: 'https://demo.replay-ai.test/members' }),
    evidence: new RecordingEvidence(),
    logger: silentLogger(),
  });
  registry.register(coordinator);
  server = await startOperatorServer({
    registry,
    logger: silentLogger(),
    evidenceDir: 'evidence',
  });
});

afterEach(async () => {
  await server.close();
});

function url(path: string): string {
  return `${server.url}/operator/session-1${path}`;
}

describe('the operator page', () => {
  it('binds to loopback only', () => {
    expect(server.url).toContain('127.0.0.1');
  });

  it('shows the intervention in Title Case, with the state a person needs', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();

    const page = await fetch(url('')).then((response) => response.text());

    expect(page).toContain('Human Intervention');
    expect(page).toContain('Current Step');
    expect(page).toContain('Control Owner');
    expect(page).toContain('Take Control');
    expect(page).toContain('Waiting For Human');
    expect(page).toContain('await-member-summary');

    await coordinator.abort('done');
    await pending;
  });

  it('offers only the actions the session can honour', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();

    const waiting = await fetch(url('')).then((response) => response.text());
    expect(waiting).toContain('Take Control');
    expect(waiting).not.toContain('Resume Automation');

    await fetch(url('/take-control'), { method: 'POST' });
    const held = await fetch(url('')).then((response) => response.text());
    expect(held).toContain('Resume Automation');
    expect(held).not.toContain('Take Control');

    await coordinator.abort('done');
    await pending;
  });

  it('answers for a session that is no longer running', async () => {
    const response = await fetch(`${server.url}/operator/does-not-exist`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Session Not Found');
  });
});

describe('the operator routes', () => {
  it('transfers control and reports the new owner', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();

    const response = await fetch(url('/take-control'), { method: 'POST' });

    expect(response.status).toBe(200);
    expect(session.controlOwner).toBe('human');

    await coordinator.abort('done');
    await pending;
  });

  it('refuses a second take-control rather than trusting the page', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();
    await fetch(url('/take-control'), { method: 'POST' });

    const second = await fetch(url('/take-control'), { method: 'POST' });

    // The state machine is the authority, so a stale tab gets an answer rather than an
    // invalid transition.
    expect(second.status).toBe(409);
    expect(session.controlOwner).toBe('human');

    await coordinator.abort('done');
    await pending;
  });

  it('refuses a resume from somebody who never took control', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();

    const response = await fetch(url('/resume'), { method: 'POST' });

    expect(response.status).toBe(409);
    expect(session.state).toBe('waitingForHuman');

    await coordinator.abort('done');
    await pending;
  });

  it('refuses a resume after an abort', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();
    await fetch(url('/take-control'), { method: 'POST' });
    await fetch(url('/abort'), { method: 'POST' });
    await pending;

    const response = await fetch(url('/resume'), { method: 'POST' });

    expect(response.status).toBe(409);
    expect(session.state).toBe('aborted');
  });

  it('returns the session as JSON for anything that wants to poll it', async () => {
    const pending = coordinator.request(CONTEXT);
    await flush();

    const view = (await fetch(url('/session')).then((response) => response.json())) as {
      state: string;
      intervention?: { code: string };
    };

    expect(view.state).toBe('waitingForHuman');
    expect(view.intervention?.code).toBe('REPLAY_WAIT_TIMEOUT');

    await coordinator.abort('done');
    await pending;
  });

  it('rejects a GET where a POST is required', async () => {
    const response = await fetch(url('/take-control'));

    expect(response.status).toBe(405);
  });
});
