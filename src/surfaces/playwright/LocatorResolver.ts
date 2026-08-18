import type { Locator, Page } from 'playwright';

import type { Logger } from '../../logging/logger.js';
import { AmbiguousTargetError, InvalidTargetError, TargetNotFoundError } from '../errors.js';
import { startStopwatch } from '../timing.js';
import type { LocatorStrategy, StrategyAttempt, Target } from '../types.js';

/**
 * Translates the surface-neutral `Target` model into Playwright locators.
 *
 * This is the only place in the codebase that knows how a strategy becomes a query, so
 * a second surface implementation writes its own resolver and reuses the target model
 * unchanged.
 */

/** Attribute names are interpolated into a selector, so only real names are allowed. */
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

export interface ResolvedTarget {
  readonly locator: Locator;
  readonly strategy: LocatorStrategy;
  readonly attempts: readonly StrategyAttempt[];
}

export interface LocatorResolverOptions {
  readonly page: Page;
  /** Ceiling for one strategy. The whole target may cost this once per strategy. */
  readonly timeoutMs: number;
  readonly logger: Logger;
}

interface Attempt {
  readonly record: StrategyAttempt;
  /** Present only when the strategy matched exactly one element. */
  readonly locator?: Locator;
}

function withExact(exact: boolean | undefined): { exact?: boolean } {
  if (exact === undefined) {
    return {};
  }
  return { exact };
}

function attributeSelector(attribute: string, value: string, targetDescription: string): string {
  if (!ATTRIBUTE_NAME_PATTERN.test(attribute)) {
    throw new InvalidTargetError(
      targetDescription,
      `"${attribute}" is not a valid HTML attribute name`,
    );
  }
  // JSON quoting escapes the quote and backslash characters that would otherwise let a
  // value break out of the attribute selector.
  return `[${attribute}=${JSON.stringify(value)}]`;
}

function buildLocator(page: Page, strategy: LocatorStrategy, targetDescription: string): Locator {
  switch (strategy.kind) {
    case 'role': {
      const options: { name?: string; exact?: boolean } = withExact(strategy.exact);
      if (strategy.name !== undefined) {
        options.name = strategy.name;
      }
      return page.getByRole(strategy.role, options);
    }
    case 'label':
      return page.getByLabel(strategy.text, withExact(strategy.exact));
    case 'placeholder':
      return page.getByPlaceholder(strategy.text, withExact(strategy.exact));
    case 'attribute':
      return page.locator(attributeSelector(strategy.attribute, strategy.value, targetDescription));
    case 'text':
      return page.getByText(strategy.text, withExact(strategy.exact));
    case 'css':
      return page.locator(strategy.selector);
  }
}

export class LocatorResolver {
  private readonly page: Page;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: LocatorResolverOptions) {
    this.page = options.page;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  /**
   * Attempts every strategy in stored order and returns the first that matches exactly
   * one element.
   *
   * A strategy matching several elements is recorded as ambiguous and skipped, never
   * narrowed to its first match: quietly picking a match is how automation clicks the
   * wrong control. When no strategy matches exactly one element the failure names every
   * attempt, so the target can be repaired without reproducing the run.
   */
  async resolve(target: Target): Promise<ResolvedTarget> {
    const attempts: StrategyAttempt[] = [];

    for (const strategy of target.strategies) {
      const attempt = await this.attempt(strategy, target.description);
      attempts.push(attempt.record);
      this.logger.debug('locator strategy attempted', {
        target: target.description,
        strategy: attempt.record.kind,
        outcome: attempt.record.outcome,
        matchCount: attempt.record.matchCount,
        durationMs: attempt.record.durationMs,
      });

      if (attempt.locator !== undefined) {
        return { locator: attempt.locator, strategy, attempts };
      }
    }

    const ambiguous = attempts.some((record) => record.outcome === 'ambiguous');
    if (ambiguous) {
      throw new AmbiguousTargetError(target.description, attempts);
    }
    throw new TargetNotFoundError(target.description, attempts);
  }

  /** Runs one strategy. Returns a locator only when exactly one element matched. */
  private async attempt(strategy: LocatorStrategy, targetDescription: string): Promise<Attempt> {
    const elapsed = startStopwatch();
    const locator = buildLocator(this.page, strategy, targetDescription);

    try {
      // State-based wait: give the element this strategy's whole budget to appear rather
      // than sleeping and hoping. `first()` keeps the wait out of Playwright strict mode,
      // so an ambiguous match is reported here instead of thrown as a library error.
      await locator.first().waitFor({ state: 'visible', timeout: this.timeoutMs });
    } catch {
      return {
        record: {
          kind: strategy.kind,
          outcome: 'not-found',
          matchCount: 0,
          durationMs: elapsed(),
        },
      };
    }

    const matchCount = await locator.count();
    if (matchCount === 1) {
      return {
        record: { kind: strategy.kind, outcome: 'resolved', matchCount, durationMs: elapsed() },
        locator,
      };
    }
    return {
      record: { kind: strategy.kind, outcome: 'ambiguous', matchCount, durationMs: elapsed() },
    };
  }
}
