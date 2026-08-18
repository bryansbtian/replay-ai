import type { Locator, Page } from 'playwright';

import type { Logger } from '../../logging/logger.js';
import type { ComputerSurface } from '../ComputerSurface.js';
import {
  ActionFailedError,
  ExtractionFailedError,
  NavigationFailedError,
  SurfaceUnavailableError,
} from '../errors.js';
import { DEFAULT_SURFACE_TIMEOUTS, type SurfaceTimeouts } from '../timeouts.js';
import { startStopwatch, type Stopwatch } from '../timing.js';
import type {
  ActionResult,
  ConditionObservation,
  ExtractionKind,
  ExtractionOptions,
  ExtractionResult,
  LocatorStrategyKind,
  Observation,
  ScreenshotResult,
  SurfaceCallOptions,
  SurfaceCondition,
  Target,
} from '../types.js';

import { LocatorResolver, type ResolvedTarget } from './LocatorResolver.js';
import { observePage } from './observation.js';

/**
 * The Playwright implementation of `ComputerSurface`.
 *
 * Everything Playwright-shaped stops here: the page, its locators, and its errors. The
 * contract, the target model, and the results this class returns contain no browser
 * types, which is what allows a workflow recorded against this surface to be applied by
 * a different surface later.
 */

export interface PlaywrightSurfaceOptions {
  /** An open page owned by the caller. The surface never closes it, see `session.ts`. */
  readonly page: Page;
  readonly logger: Logger;
  readonly timeouts?: SurfaceTimeouts;
}

/**
 * Playwright failure messages carry a multi-line call log and a DOM excerpt. Higher
 * layers get the first line, which names the failure; the whole error is preserved as
 * the `cause` for anyone debugging.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split('\n')[0] ?? error.name;
  }
  return 'unknown failure';
}

/** Rendered into `ConditionObservation.observed`, so it is bounded and readable. */
const MAX_OBSERVED_CHARS = 120;

const NOT_VISIBLE = 'Not Visible';
const VISIBLE = 'Visible';
const UNREADABLE = 'Unreadable';

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_OBSERVED_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_OBSERVED_CHARS)}...`;
}

/** A `textVisible` condition is a target with one text strategy, so it shares one path. */
function textTarget(text: string): Target {
  return { description: `Text "${text}"`, strategies: [{ kind: 'text', text }] };
}

export class PlaywrightSurface implements ComputerSurface {
  private readonly page: Page;
  private readonly logger: Logger;
  private readonly timeouts: SurfaceTimeouts;
  private readonly resolver: LocatorResolver;

  constructor(options: PlaywrightSurfaceOptions) {
    this.page = options.page;
    this.logger = options.logger.child({ surface: 'playwright' });
    this.timeouts = options.timeouts ?? DEFAULT_SURFACE_TIMEOUTS;
    this.resolver = new LocatorResolver({
      page: options.page,
      timeoutMs: this.timeouts.locatorMs,
      logger: this.logger,
    });
  }

  async navigate(url: string, options: SurfaceCallOptions = {}): Promise<ActionResult> {
    this.ensureAvailable();
    const elapsed = startStopwatch();
    const timeout = options.timeoutMs ?? this.timeouts.navigationMs;

    try {
      // `domcontentloaded` rather than `load`: a legacy page with a slow third-party
      // asset can keep `load` pending long past the point where it is usable, and every
      // subsequent step waits for its own target anyway.
      const response = await this.page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
      if (response !== null && !response.ok()) {
        throw new NavigationFailedError(url, `the surface responded ${response.status()}`);
      }
    } catch (error) {
      if (error instanceof NavigationFailedError) {
        throw error;
      }
      throw new NavigationFailedError(url, describeFailure(error), { cause: error });
    }

    const result: ActionResult = {
      action: 'navigate',
      durationMs: elapsed(),
      url: this.page.url(),
    };
    this.logger.debug('navigated', { url: result.url, durationMs: result.durationMs });
    return result;
  }

  async observe(): Promise<Observation> {
    this.ensureAvailable();
    const observation = await observePage(this.page, this.timeouts.actionMs);
    this.logger.debug('observed surface', {
      url: observation.url,
      controlCount: observation.controls.length,
      truncated: observation.truncated,
      durationMs: observation.durationMs,
    });
    return observation;
  }

  async click(target: Target, options: SurfaceCallOptions = {}): Promise<ActionResult> {
    this.ensureAvailable();
    const elapsed = startStopwatch();
    const resolved = await this.resolver.resolve(target, options.timeoutMs);

    try {
      // Playwright waits for the element to be enabled, stable, and hit-testable before
      // clicking, so a disabled control fails on this timeout instead of dropping the
      // click silently.
      await resolved.locator.click({ timeout: options.timeoutMs ?? this.timeouts.actionMs });
    } catch (error) {
      throw new ActionFailedError('click', target.description, describeFailure(error), {
        cause: error,
      });
    }

    return this.completed('click', target, resolved, elapsed());
  }

  async fill(
    target: Target,
    value: string,
    options: SurfaceCallOptions = {},
  ): Promise<ActionResult> {
    this.ensureAvailable();
    const elapsed = startStopwatch();
    const resolved = await this.resolver.resolve(target, options.timeoutMs);

    try {
      // `fill` replaces the current contents, which is the behaviour a replay needs:
      // appending to whatever a previous step left behind is not reproducible.
      await resolved.locator.fill(value, { timeout: options.timeoutMs ?? this.timeouts.actionMs });
    } catch (error) {
      throw new ActionFailedError('fill', target.description, describeFailure(error), {
        cause: error,
      });
    }

    return this.completed('fill', target, resolved, elapsed());
  }

  async extract(target: Target, options: ExtractionOptions = {}): Promise<ExtractionResult> {
    this.ensureAvailable();
    const elapsed = startStopwatch();
    const kind = options.kind ?? 'text';
    const resolved = await this.resolver.resolve(target, options.timeoutMs);
    const value = await this.read(target, resolved, kind, options.attribute, options.timeoutMs);

    const result: ExtractionResult = {
      kind,
      value,
      durationMs: elapsed(),
      resolvedBy: resolved.strategy.kind,
    };
    // The extracted value itself is never logged: it may be a value a user typed.
    this.logger.debug('extracted from target', {
      target: target.description,
      kind,
      valueLength: value.length,
      strategy: result.resolvedBy,
      durationMs: result.durationMs,
    });
    return result;
  }

  async waitFor(
    condition: SurfaceCondition,
    options: SurfaceCallOptions = {},
  ): Promise<ConditionObservation> {
    this.ensureAvailable();
    const elapsed = startStopwatch();
    // The locator budget is the right default: a condition is a question about whether
    // something is on screen, which is the same wait a locator strategy performs.
    const budgetMs = options.timeoutMs ?? this.timeouts.locatorMs;

    const observation = await this.observeCondition(condition, budgetMs, elapsed);
    this.logger.debug('condition evaluated', {
      condition: observation.condition,
      satisfied: observation.satisfied,
      durationMs: observation.durationMs,
    });
    return observation;
  }

  private async observeCondition(
    condition: SurfaceCondition,
    budgetMs: number,
    elapsed: Stopwatch,
  ): Promise<ConditionObservation> {
    switch (condition.type) {
      case 'urlMatches':
        return await this.observeUrl(condition.pattern, budgetMs, elapsed);
      case 'textVisible':
        return await this.observeVisible(
          'textVisible',
          textTarget(condition.text),
          budgetMs,
          elapsed,
        );
      case 'targetVisible':
        return await this.observeVisible('targetVisible', condition.target, budgetMs, elapsed);
      case 'targetContainsText':
        return await this.observeContainsText(condition.target, condition.text, budgetMs, elapsed);
    }
  }

  private async observeUrl(
    pattern: string,
    budgetMs: number,
    elapsed: Stopwatch,
  ): Promise<ConditionObservation> {
    const expression = new RegExp(pattern);
    let satisfied = true;
    try {
      // `commit` rather than the default `load`: the question is where the surface is,
      // not whether every asset of the destination has finished downloading.
      await this.page.waitForURL(expression, { timeout: budgetMs, waitUntil: 'commit' });
    } catch {
      satisfied = false;
    }
    return {
      condition: 'urlMatches',
      satisfied,
      observed: this.page.url(),
      durationMs: elapsed(),
    };
  }

  private async observeVisible(
    condition: 'targetVisible' | 'textVisible',
    target: Target,
    budgetMs: number,
    elapsed: Stopwatch,
  ): Promise<ConditionObservation> {
    const found = await this.firstVisible(target, budgetMs);
    if (found === undefined) {
      return { condition, satisfied: false, observed: NOT_VISIBLE, durationMs: elapsed() };
    }
    return {
      condition,
      satisfied: true,
      observed: VISIBLE,
      durationMs: elapsed(),
      resolvedBy: found.strategy,
    };
  }

  private async observeContainsText(
    target: Target,
    text: string,
    budgetMs: number,
    elapsed: Stopwatch,
  ): Promise<ConditionObservation> {
    // Half the budget to find the element, half for the text to appear inside it. A
    // failure then reports which of the two did not happen, instead of one opaque
    // timeout that could mean either.
    const half = Math.max(1, Math.floor(budgetMs / 2));
    const found = await this.firstVisible(target, half);
    if (found === undefined) {
      return {
        condition: 'targetContainsText',
        satisfied: false,
        observed: NOT_VISIBLE,
        durationMs: elapsed(),
      };
    }

    let satisfied = true;
    try {
      // `filter` matches on normalized text, so trailing whitespace and line wrapping in
      // the markup cannot decide whether a checkpoint passes.
      await found.locator
        .filter({ hasText: text })
        .first()
        .waitFor({ state: 'visible', timeout: budgetMs - half });
    } catch {
      satisfied = false;
    }

    return {
      condition: 'targetContainsText',
      satisfied,
      observed: await this.readObserved(found.locator),
      durationMs: elapsed(),
      resolvedBy: found.strategy,
    };
  }

  /**
   * The first strategy whose locator becomes visible within its share of the budget.
   *
   * The budget is divided evenly rather than handed to each strategy in turn, so a
   * leading strategy that never matches cannot consume the whole allowance and starve
   * the strategy that would have answered.
   */
  private async firstVisible(
    target: Target,
    budgetMs: number,
  ): Promise<{ locator: Locator; strategy: LocatorStrategyKind } | undefined> {
    const candidates = this.resolver.candidates(target);
    const perStrategy = Math.max(1, Math.floor(budgetMs / candidates.length));

    for (const candidate of candidates) {
      try {
        await candidate.locator.first().waitFor({ state: 'visible', timeout: perStrategy });
      } catch {
        continue;
      }
      return { locator: candidate.locator, strategy: candidate.strategy.kind };
    }
    return undefined;
  }

  /** Best-effort text of an element, for a failure message. Never throws. */
  private async readObserved(locator: Locator): Promise<string> {
    try {
      return summarize(await locator.first().innerText({ timeout: this.timeouts.actionMs }));
    } catch {
      return UNREADABLE;
    }
  }

  async screenshot(): Promise<ScreenshotResult> {
    this.ensureAvailable();
    const elapsed = startStopwatch();

    let data: Uint8Array;
    try {
      data = await this.page.screenshot({ timeout: this.timeouts.actionMs, type: 'png' });
    } catch (error) {
      throw new ActionFailedError('screenshot', 'surface', describeFailure(error), {
        cause: error,
      });
    }

    const result: ScreenshotResult = {
      format: 'png',
      data,
      byteLength: data.byteLength,
      capturedAt: new Date().toISOString(),
      url: this.page.url(),
      durationMs: elapsed(),
    };
    this.logger.debug('captured screenshot', {
      url: result.url,
      byteLength: result.byteLength,
      durationMs: result.durationMs,
    });
    return result;
  }

  /** Reads one piece of content off an already-resolved element. */
  private async read(
    target: Target,
    resolved: ResolvedTarget,
    kind: ExtractionKind,
    attribute: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<string> {
    const timeout = timeoutMs ?? this.timeouts.actionMs;

    try {
      if (kind === 'text') {
        return await resolved.locator.innerText({ timeout });
      }
      if (kind === 'value') {
        return await resolved.locator.inputValue({ timeout });
      }
      if (attribute === undefined) {
        throw new ExtractionFailedError(
          target.description,
          'an attribute name is required when extracting an attribute',
        );
      }
      const found = await resolved.locator.getAttribute(attribute, { timeout });
      if (found === null) {
        throw new ExtractionFailedError(
          target.description,
          `the element carries no "${attribute}" attribute`,
        );
      }
      return found;
    } catch (error) {
      if (error instanceof ExtractionFailedError) {
        throw error;
      }
      throw new ExtractionFailedError(target.description, describeFailure(error), { cause: error });
    }
  }

  private completed(
    action: 'click' | 'fill',
    target: Target,
    resolved: ResolvedTarget,
    durationMs: number,
  ): ActionResult {
    const result: ActionResult = {
      action,
      durationMs,
      url: this.page.url(),
      resolvedBy: resolved.strategy.kind,
    };
    // Deliberately no value field: a filled value can be a password or personal data.
    this.logger.debug('action completed', {
      action,
      target: target.description,
      strategy: result.resolvedBy,
      durationMs,
    });
    return result;
  }

  /**
   * A closed page reports as a surface failure rather than as a Playwright error about
   * a target being closed, which reads like a bug in the workflow.
   */
  private ensureAvailable(): void {
    if (this.page.isClosed()) {
      throw new SurfaceUnavailableError('the page has been closed');
    }
  }
}
