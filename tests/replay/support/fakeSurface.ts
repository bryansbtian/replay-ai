import type {
  ActionResult,
  ComputerSurface,
  ConditionObservation,
  ExtractionOptions,
  ExtractionResult,
  Observation,
  ScreenshotResult,
  SurfaceCallOptions,
  SurfaceCondition,
  Target,
} from '../../../src/surfaces/index.js';

/**
 * A `ComputerSurface` that answers from a script instead of from an application.
 *
 * The replay suites use it for everything that is about the engine rather than about a
 * browser: which steps ran, in what order, how many times, with which budgets, and what
 * a failure reported. That keeps those suites fast and exact, and leaves the real
 * browser to `browserReplay.test.ts`, which is where the Phase 2 to Phase 4 chain is
 * actually proved.
 */

export interface RecordedCall {
  readonly method: 'navigate' | 'click' | 'fill' | 'extract' | 'waitFor' | 'observe' | 'screenshot';
  /** The url, the target description, or the condition type. */
  readonly subject: string;
  readonly timeoutMs?: number;
}

export interface FakeBehavior {
  readonly url?: string;
  navigate?(url: string): void | Promise<void>;
  click?(target: Target): void | Promise<void>;
  fill?(target: Target, value: string): void | Promise<void>;
  extract?(target: Target): string | Promise<string>;
  waitFor?(condition: SurfaceCondition): boolean | Promise<boolean>;
}

function subjectOf(condition: SurfaceCondition): string {
  if (condition.type === 'urlMatches') {
    return condition.pattern;
  }
  if (condition.type === 'textVisible') {
    return condition.text;
  }
  return condition.target.description;
}

export class FakeSurface implements ComputerSurface {
  readonly calls: RecordedCall[] = [];
  /** Values handed to `fill`, so a suite can prove what a parameter resolved to. */
  readonly fills: { readonly target: string; readonly value: string }[] = [];

  private readonly behavior: FakeBehavior;

  constructor(behavior: FakeBehavior = {}) {
    this.behavior = behavior;
  }

  /** Just the method names, which is what an ordering assertion reads best as. */
  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  private record(call: RecordedCall): void {
    this.calls.push(call);
  }

  async navigate(url: string, options: SurfaceCallOptions = {}): Promise<ActionResult> {
    this.record({ method: 'navigate', subject: url, ...timeout(options) });
    await this.behavior.navigate?.(url);
    return { action: 'navigate', durationMs: 1, url };
  }

  // Not `async`: a scripted surface has nothing to await, and the contract only asks
  // for a promise.
  observe(): Promise<Observation> {
    this.record({ method: 'observe', subject: this.url() });
    return Promise.resolve({
      url: this.url(),
      title: 'Fake Surface',
      capturedAt: new Date().toISOString(),
      textSummary: '',
      truncated: false,
      controls: [],
      durationMs: 1,
    });
  }

  async click(target: Target, options: SurfaceCallOptions = {}): Promise<ActionResult> {
    this.record({ method: 'click', subject: target.description, ...timeout(options) });
    await this.behavior.click?.(target);
    return { action: 'click', durationMs: 1, url: this.url(), resolvedBy: 'role' };
  }

  async fill(
    target: Target,
    value: string,
    options: SurfaceCallOptions = {},
  ): Promise<ActionResult> {
    this.record({ method: 'fill', subject: target.description, ...timeout(options) });
    this.fills.push({ target: target.description, value });
    await this.behavior.fill?.(target, value);
    return { action: 'fill', durationMs: 1, url: this.url(), resolvedBy: 'label' };
  }

  async extract(target: Target, options: ExtractionOptions = {}): Promise<ExtractionResult> {
    this.record({ method: 'extract', subject: target.description, ...timeout(options) });
    const value = await this.behavior.extract?.(target);
    return { kind: 'text', value: value ?? '', durationMs: 1, resolvedBy: 'attribute' };
  }

  async waitFor(
    condition: SurfaceCondition,
    options: SurfaceCallOptions = {},
  ): Promise<ConditionObservation> {
    this.record({ method: 'waitFor', subject: subjectOf(condition), ...timeout(options) });
    const satisfied = await this.behavior.waitFor?.(condition);
    const answer = satisfied ?? true;
    return {
      condition: condition.type,
      satisfied: answer,
      observed: describeObserved(answer),
      durationMs: 1,
    };
  }

  screenshot(): Promise<ScreenshotResult> {
    this.record({ method: 'screenshot', subject: this.url() });
    return Promise.resolve({
      format: 'png',
      data: new Uint8Array(),
      byteLength: 0,
      capturedAt: new Date().toISOString(),
      url: this.url(),
      durationMs: 1,
    });
  }

  private url(): string {
    return this.behavior.url ?? 'https://demo.replay-ai.test/members';
  }
}

function describeObserved(satisfied: boolean): string {
  if (satisfied) {
    return 'Visible';
  }
  return 'Not Visible';
}

/** `exactOptionalPropertyTypes` refuses an explicitly undefined `timeoutMs`. */
function timeout(options: SurfaceCallOptions): { timeoutMs?: number } {
  if (options.timeoutMs === undefined) {
    return {};
  }
  return { timeoutMs: options.timeoutMs };
}

/** A surface whose every call never settles, for proving replay still gives up. */
export class HangingSurface extends FakeSurface {
  constructor() {
    super({
      navigate: () => new Promise<void>(() => {}),
      click: () => new Promise<void>(() => {}),
      waitFor: () => new Promise<boolean>(() => {}),
    });
  }
}
