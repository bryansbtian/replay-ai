import { InvalidTargetError } from './errors.js';
import type { LocatorStrategy, LocatorStrategyKind, Target } from './types.js';

/**
 * Default resolution order, most robust first.
 *
 * Role and label describe what a control *is* to a user, so they survive redesigns,
 * class-name churn, and re-generated markup. CSS is last because a selector such as
 * `div:nth-child(3) > button` encodes the layout of the day, and legacy applications
 * are exactly where that layout changes without notice.
 */
const STRATEGY_PRIORITY: Readonly<Record<LocatorStrategyKind, number>> = {
  role: 0,
  label: 1,
  placeholder: 2,
  attribute: 3,
  text: 4,
  css: 5,
};

export const DEFAULT_STRATEGY_ORDER: readonly LocatorStrategyKind[] = [
  'role',
  'label',
  'placeholder',
  'attribute',
  'text',
  'css',
];

export interface CreateTargetOptions {
  /**
   * `priority` sorts the strategies into the default order. `as-given` keeps the caller's
   * order, for the case where a specific application is known to need it.
   */
  readonly ordering?: 'priority' | 'as-given';
}

function comparePriority(left: LocatorStrategy, right: LocatorStrategy): number {
  return STRATEGY_PRIORITY[left.kind] - STRATEGY_PRIORITY[right.kind];
}

/**
 * Builds a target with its strategies in the order a resolver must attempt them.
 *
 * Ordering is decided once, here, and then stored on the target: a resolver never
 * re-sorts, so a recorded workflow resolves the same way on every run.
 */
export function createTarget(
  description: string,
  strategies: readonly LocatorStrategy[],
  options: CreateTargetOptions = {},
): Target {
  if (strategies.length === 0) {
    throw new InvalidTargetError(description, 'a target must carry at least one strategy');
  }

  const ordering = options.ordering ?? 'priority';
  if (ordering === 'as-given') {
    return { description, strategies: [...strategies] };
  }

  // Array.prototype.sort is stable, so two strategies of the same kind keep the order
  // the caller supplied them in.
  return { description, strategies: [...strategies].sort(comparePriority) };
}
