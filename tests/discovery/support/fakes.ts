import type {
  EvidenceRecorder,
  RunEvent,
  RunOutcomeRecord,
  RunStartRecord,
} from '../../../src/evidence/index.js';
import type { LLMClient, ModelRequest, ModelResponse } from '../../../src/llm/index.js';
import { createLogger, type Logger } from '../../../src/logging/logger.js';
import { StaticPolicyEngine, type PolicyConfig } from '../../../src/policy/index.js';
import type { SurfaceTimeouts } from '../../../src/surfaces/index.js';

/**
 * The doubles a discovery suite needs, and the boundary each one stands in for.
 *
 * Only the model is faked in anger. The surface, the guardrail, and the recorder are the
 * real contracts with scripted or in-memory implementations, because the point of these
 * suites is what the loop does with a model answer, and replacing the parts that judge
 * that answer would be testing nothing.
 */

/** What the model was asked, reduced to what an assertion cares about. */
export interface RecordedRequest {
  readonly system: string;
  readonly instruction: string;
  readonly timeoutMs: number | undefined;
}

/**
 * An `LLMClient` that answers from a script.
 *
 * A script entry is either the text of a response or a function that throws, so one fake
 * covers a valid decision, a malformed answer, and a provider failure without three
 * classes. Running past the end of the script is an explicit failure rather than a
 * repeat, because a loop that asked one more time than a suite expected is exactly the
 * defect these tests exist to catch.
 */
export class ScriptedLlm implements LLMClient {
  readonly requests: RecordedRequest[] = [];

  private readonly script: readonly (string | (() => never))[];
  private index = 0;

  constructor(script: readonly (string | (() => never))[]) {
    this.script = script;
  }

  get callCount(): number {
    return this.index;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({
      system: request.system,
      instruction: request.instruction,
      timeoutMs: request.timeoutMs,
    });

    const entry = this.script[this.index];
    this.index += 1;
    if (entry === undefined) {
      throw new Error(`ScriptedLlm was called ${this.index} times and has no answer for that`);
    }
    if (typeof entry === 'function') {
      entry();
    }

    return Promise.resolve({
      text: entry as string,
      model: 'scripted-model',
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 1,
    });
  }
}

/** An `LLMClient` that never settles, for proving the run deadline is the outer bound. */
export class HangingLlm implements LLMClient {
  complete(): Promise<ModelResponse> {
    return new Promise<ModelResponse>(() => {});
  }
}

/** One line of what a run wrote down. */
export interface RecordedEvent {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * An `EvidenceRecorder` that keeps events in memory.
 *
 * Deliberately not a stub: a suite asserting that a value never reaches evidence has to
 * see everything a run tried to write, which is the whole record rather than a count of
 * it.
 */
export class RecordingEvidence implements EvidenceRecorder {
  readonly runId = '00000000-0000-4000-8000-000000000000';
  readonly directory = '/evidence/runs/test';
  readonly capturesScreenshots = false;
  readonly warnings: string[] = [];
  readonly events: RecordedEvent[] = [];

  startRecord?: RunStartRecord;
  outcome?: RunOutcomeRecord;

  start(record: RunStartRecord): Promise<void> {
    this.startRecord = record;
    return Promise.resolve();
  }

  recordEvent(event: RunEvent): Promise<void> {
    this.events.push({ event: event.event, fields: event.fields ?? {} });
    return Promise.resolve();
  }

  saveScreenshot(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  complete(outcome: RunOutcomeRecord): Promise<void> {
    this.outcome = outcome;
    return Promise.resolve();
  }

  /** Every event of one name, for an assertion about a particular moment. */
  named(event: string): RecordedEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }

  names(): string[] {
    return this.events.map((entry) => entry.event);
  }

  /** Every recorded field value, flattened, for proving a string is nowhere in the record. */
  serialized(): string {
    return JSON.stringify(this.events);
  }
}

/** A logger that writes nowhere, so a suite's output is its assertions. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', write: () => {} });
}

export const TEST_TIMEOUTS: SurfaceTimeouts = {
  navigationMs: 5_000,
  locatorMs: 2_000,
  actionMs: 3_000,
};

/**
 * A policy that permits the local test host and nothing else, which is the shape a real
 * deployment's configuration has.
 */
export function testPolicy(overrides: Partial<PolicyConfig> = {}): StaticPolicyEngine {
  return new StaticPolicyEngine({
    allowedHosts: ['demo.replay-ai.test'],
    allowedSchemes: ['https'],
    allowedRoutes: [],
    allowedActions: ['navigate', 'click', 'fill', 'extract', 'wait', 'checkpoint'],
    riskPolicy: { safe: 'allow', risky: 'requireConfirmation', irreversible: 'block' },
    ...overrides,
  });
}
