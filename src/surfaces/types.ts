/**
 * The vocabulary every surface speaks.
 *
 * Nothing here refers to a browser, a DOM, or Playwright. A discovered workflow is
 * recorded in these terms, so the same recording can later be applied by a different
 * surface implementation (legacy web, accessibility tree, desktop) without rewriting
 * the steps.
 */

/**
 * ARIA roles the target model supports. A curated subset rather than the full ARIA
 * list: every entry is a role real automation targets, and keeping the union closed
 * means a mistyped role fails at compile time instead of resolving to nothing at run
 * time.
 *
 * Kept as a runtime list as well, so that a schema validating a recorded target can
 * check a role against the same vocabulary instead of restating it.
 */
export const TARGET_ROLES = [
  'alert',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'dialog',
  'form',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'main',
  'menu',
  'menuitem',
  'navigation',
  'option',
  'progressbar',
  'radio',
  'region',
  'row',
  'searchbox',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tabpanel',
  'textbox',
  'tooltip',
] as const;

export type TargetRole = (typeof TARGET_ROLES)[number];

/** Matches by accessible role, optionally narrowed by accessible name. */
export interface RoleLocator {
  readonly kind: 'role';
  readonly role: TargetRole;
  readonly name?: string;
  readonly exact?: boolean;
}

/** Matches a form control by its associated label text. */
export interface LabelLocator {
  readonly kind: 'label';
  readonly text: string;
  readonly exact?: boolean;
}

/** Matches a form control by its placeholder text. */
export interface PlaceholderLocator {
  readonly kind: 'placeholder';
  readonly text: string;
  readonly exact?: boolean;
}

/**
 * Matches an attribute a team has committed to keeping stable, such as `data-testid`.
 * The attribute name is explicit because legacy applications rarely use the convention
 * a tool would guess.
 */
export interface StableAttributeLocator {
  readonly kind: 'attribute';
  readonly attribute: string;
  readonly value: string;
}

/** Matches by visible text content. */
export interface TextLocator {
  readonly kind: 'text';
  readonly text: string;
  readonly exact?: boolean;
}

/** Last resort for markup with no semantics to hold on to. */
export interface CssLocator {
  readonly kind: 'css';
  readonly selector: string;
}

export type LocatorStrategy =
  | RoleLocator
  | LabelLocator
  | PlaceholderLocator
  | StableAttributeLocator
  | TextLocator
  | CssLocator;

export type LocatorStrategyKind = LocatorStrategy['kind'];

/**
 * One control, described by every way we know to find it.
 *
 * Strategies are attempted in stored order, so the order is part of the recording and
 * a replay resolves exactly the way discovery did.
 */
export interface Target {
  /** Human-readable name used in logs and error messages. Never a value the user typed. */
  readonly description: string;
  readonly strategies: readonly LocatorStrategy[];
}

/** What a resolution attempt against one strategy produced. */
export type AttemptOutcome = 'resolved' | 'not-found' | 'ambiguous';

export interface StrategyAttempt {
  readonly kind: LocatorStrategyKind;
  readonly outcome: AttemptOutcome;
  /** Number of elements the strategy matched. */
  readonly matchCount: number;
  readonly durationMs: number;
}

export type SurfaceActionName = 'navigate' | 'click' | 'fill';

/**
 * Outcome of an action that changed the surface.
 *
 * There is no `success` flag: a failed action throws a typed surface error carrying its
 * own context, so a returned result always describes a completed action.
 */
export interface ActionResult {
  readonly action: SurfaceActionName;
  readonly durationMs: number;
  /** Surface location after the action, for evidence and debugging. */
  readonly url: string;
  /** Which strategy actually resolved the target. Absent for actions without a target. */
  readonly resolvedBy?: LocatorStrategyKind;
}

/** What to read off a resolved target. */
export type ExtractionKind = 'text' | 'value' | 'attribute';

export interface ExtractionOptions {
  readonly kind?: ExtractionKind;
  /** Required when `kind` is `attribute`. */
  readonly attribute?: string;
}

export interface ExtractionResult {
  readonly kind: ExtractionKind;
  readonly value: string;
  readonly durationMs: number;
  readonly resolvedBy: LocatorStrategyKind;
}

/** A control the surface noticed while observing. Values are never included. */
export interface ObservedControl {
  readonly role: string;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * A bounded snapshot of the surface.
 *
 * Deliberately a summary rather than a dump: it is written to evidence on every step,
 * and a full serialized page would be unreadable, expensive, and likely to capture
 * values a user typed.
 */
export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  /** Visible text, collapsed and truncated. */
  readonly textSummary: string;
  readonly truncated: boolean;
  readonly controls: readonly ObservedControl[];
  readonly durationMs: number;
}

export interface ScreenshotResult {
  readonly format: 'png';
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly capturedAt: string;
  readonly url: string;
  readonly durationMs: number;
}
