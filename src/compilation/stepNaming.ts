import type { AgentAction } from '../discovery/index.js';

/**
 * Step ids a reviewer can read.
 *
 * `step-1` through `step-6` would satisfy the schema and tell nobody anything. An artifact
 * is meant to be reviewed by a person deciding whether to trust it, and the ids are the
 * table of contents: `enter-member-id` followed by `click-search` followed by
 * `read-savings-balance` is the workflow, readable without opening a single target.
 *
 * The name comes from what the action does and which control it names, both of which the
 * trace already carries. Nothing is asked of a model, so the same run always compiles to
 * the same ids.
 */

const MAX_ID_LENGTH = 64;

/** Words that add nothing once the verb is in front of them. `click-search-button` reads worse. */
const REDUNDANT_SUFFIXES = ['field', 'button', 'input', 'box', 'link', 'value', 'text'];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Splits a camelCase name so `savingsBalance` becomes `savings-balance`. */
function fromCamelCase(value: string): string {
  return slug(value.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
}

function withoutRedundantSuffix(value: string): string {
  const parts = value.split('-');
  const last = parts.at(-1);
  if (parts.length > 1 && last !== undefined && REDUNDANT_SUFFIXES.includes(last)) {
    return parts.slice(0, -1).join('-');
  }
  return value;
}

/** The subject of a wait, so `await-member-summary` says what is being waited for. */
function conditionSubject(action: Extract<AgentAction, { type: 'wait' }>): string {
  const condition = action.condition;
  if (condition.type === 'textVisible') {
    return slug(condition.text);
  }
  if (condition.type === 'urlMatches') {
    return 'location';
  }
  return slug(condition.target.description);
}

/**
 * A readable id for one action, before uniqueness is applied.
 *
 * The verb is the action, so a reader can tell a fill from a click without reading the
 * type. A control the model described in words nobody can slug falls back to the action
 * name alone, which `UniqueStepIds` then numbers.
 */
export function stepIdFor(action: AgentAction): string {
  switch (action.type) {
    case 'navigate':
      return 'open-page';
    case 'click':
      return prefixed('click', withoutRedundantSuffix(slug(action.target.description)));
    case 'fill':
      return prefixed('enter', withoutRedundantSuffix(slug(action.target.description)));
    case 'extract':
      return prefixed('read', fromCamelCase(action.name));
    case 'wait':
      return prefixed('await', withoutRedundantSuffix(conditionSubject(action)));
  }
}

function prefixed(verb: string, subject: string): string {
  if (subject === '') {
    return verb;
  }
  return `${verb}-${subject}`.slice(0, MAX_ID_LENGTH).replace(/-+$/, '');
}

/**
 * Hands out ids, keeping them unique.
 *
 * A workflow that clicks the same control twice would otherwise produce the same id twice,
 * which the schema rejects. Numbering the repeats keeps both readable and keeps the first
 * one unchanged, so an artifact does not acquire a `-1` suffix simply because a later step
 * exists.
 */
export class UniqueStepIds {
  private readonly taken = new Set<string>();

  claim(candidate: string): string {
    let base = candidate;
    if (base === '') {
      base = 'step';
    }
    if (!this.taken.has(base)) {
      this.taken.add(base);
      return base;
    }

    for (let suffix = 2; ; suffix += 1) {
      const next = `${base}-${suffix}`;
      if (!this.taken.has(next)) {
        this.taken.add(next);
        return next;
      }
    }
  }
}
