import type {
  ActionOutcome,
  AgentAction,
  DiscoveredValue,
  DiscoveryInput,
  DiscoveryTrace,
  DiscoveryTraceEntry,
  ObservationSummary,
} from '../../../src/discovery/index.js';
import type { ObservedControl } from '../../../src/surfaces/index.js';

/**
 * Deterministic discovery traces, built by hand.
 *
 * Compilation is a pure transformation of a trace, so its suites need traces rather than
 * model runs. Writing them out here rather than capturing one from a live run is what
 * keeps these tests fast, offline, and precise: a case about parameterization can supply
 * exactly the two values it wants to reason about.
 */

/** The target shape a discovered action carries. */
type ActionTarget = Extract<AgentAction, { type: 'click' }>['target'];

export const ENTRY_POINT = 'https://demo.replay-ai.test/members';

/** The screen before anything happened. */
export const SEARCH_SCREEN: readonly ObservedControl[] = [
  { role: 'heading', name: 'Demo Member Lookup', enabled: true },
  { role: 'textbox', name: 'Member ID', enabled: true },
  { role: 'button', name: 'Search', enabled: true },
];

/** The screen the workflow arrives at, carrying two controls that were not there before. */
export const SUMMARY_SCREEN: readonly ObservedControl[] = [
  ...SEARCH_SCREEN,
  { role: 'region', name: 'Member Summary', enabled: true },
  { role: 'heading', name: 'Member Summary', enabled: true },
];

/**
 * Targets as a discovery run would have described them.
 *
 * Typed as the target an `AgentAction` carries, so a
 * mistyped role or an unsupported strategy kind fails here rather than at run time.
 */
export const MEMBER_ID_FIELD: ActionTarget = {
  description: 'Member ID Field',
  strategies: [
    { kind: 'label', text: 'Member ID' },
    { kind: 'role', role: 'textbox', name: 'Member ID' },
  ],
};

export const SEARCH_BUTTON: ActionTarget = {
  description: 'Search Button',
  strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
};

export const BALANCE_FIELD: ActionTarget = {
  description: 'Savings Balance',
  strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
};

function observation(
  controls: readonly ObservedControl[],
  title = 'Demo Member Lookup',
): ObservationSummary {
  return {
    url: ENTRY_POINT,
    title,
    controlCount: controls.length,
    controls,
    textLength: 64,
    fingerprint: controls.map((control) => control.name).join('|'),
  };
}

export interface TraceEntryOptions {
  readonly ok?: boolean;
  readonly before?: readonly ObservedControl[];
  readonly after?: readonly ObservedControl[];
  readonly summary?: string;
}

export function entry(
  step: number,
  action: AgentAction,
  options: TraceEntryOptions = {},
): DiscoveryTraceEntry {
  const ok = options.ok ?? true;
  const outcome: ActionOutcome = { ok, durationMs: 5 };
  if (!ok) {
    return {
      step,
      observation: observation(options.before ?? SEARCH_SCREEN),
      decisionType: 'action',
      summary: options.summary ?? `Step ${step}`,
      action,
      policy: 'allow',
      outcome: { ...outcome, code: 'SURFACE_TARGET_NOT_FOUND' },
      stateAfter: observation(options.after ?? SEARCH_SCREEN),
    };
  }
  return {
    step,
    observation: observation(options.before ?? SEARCH_SCREEN),
    decisionType: 'action',
    summary: options.summary ?? `Step ${step}`,
    action,
    policy: 'allow',
    outcome,
    stateAfter: observation(options.after ?? SEARCH_SCREEN),
  };
}

export interface TraceOptions {
  readonly inputs?: readonly DiscoveryInput[];
  readonly entries?: readonly DiscoveryTraceEntry[];
  readonly discovered?: readonly DiscoveredValue[];
  readonly entryPoint?: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

/**
 * The member lookup workflow as a successful run would have recorded it: type a
 * reference, submit, wait for the summary, read the balance.
 */
export function memberLookupTrace(options: TraceOptions = {}): DiscoveryTrace {
  const entries = options.entries ?? [
    entry(1, { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }),
    entry(2, { type: 'click', target: SEARCH_BUTTON }),
    entry(3, {
      type: 'wait',
      condition: { type: 'textVisible', text: 'Member Summary' },
    }),
    entry(
      4,
      { type: 'extract', target: BALANCE_FIELD, name: 'savingsBalance' },
      {
        before: SUMMARY_SCREEN,
        after: SUMMARY_SCREEN,
      },
    ),
  ];

  return {
    runId: '33333333-3333-4333-8333-333333333333',
    goal: 'Look Up Demo Member 12345 And Read Their Savings Balance',
    application: {
      name: 'Demo Member Lookup',
      entryPoint: options.entryPoint ?? ENTRY_POINT,
    },
    inputs: options.inputs ?? [{ name: 'memberId', value: '12345' }],
    entries,
    discovered: options.discovered ?? [{ name: 'savingsBalance', value: '5234.17', step: 4 }],
    outputs: options.outputs ?? { savingsBalance: '5234.17' },
  };
}

/**
 * A trace whose last successful action leaves the screen exactly as it started.
 *
 * Used for the case where no observed state proves the workflow arrived anywhere, which
 * has to be a compilation failure rather than a capability with a success condition that
 * cannot fail.
 */
export function goesNowhereTrace(): DiscoveryTrace {
  return memberLookupTrace({
    entries: [entry(1, { type: 'click', target: SEARCH_BUTTON })],
    inputs: [],
    discovered: [],
    outputs: {},
  });
}
