/**
 * The seam a run asks for a person through.
 *
 * It lives here, beside the deadline guard, because two very different engines need the
 * same thing and neither should know how it is answered. Replay reaches this point when a
 * state it cannot clear stops it; discovery reaches it when the model says it should not
 * decide something. What happens next (a request appearing in an operator UI, somebody
 * taking control of the browser, a resume) belongs entirely to `handoff/`.
 *
 * Keeping the contract this small is what stops the dependency going the wrong way. Replay
 * imports an interface with one method; it does not import a session registry, a server, or
 * a state machine, and it cannot be made to care whether a human was reachable.
 */

/**
 * Why a run stopped and asked for somebody.
 *
 * Deliberately few, and each one is a genuinely different situation for the person who
 * answers it. The specific failure that caused it travels alongside as an existing Phase 5
 * or Phase 6 code rather than being restated here, so this stays a routing category rather
 * than a second error taxonomy.
 */
export const INTERVENTION_REASONS = [
  /** The application showed something the workflow does not know how to get past. */
  'UNRECOVERABLE_FAILURE',
  /** The deployment's policy allows this action only with a person present. */
  'POLICY_CONFIRMATION_REQUIRED',
  /** Discovery decided it should not be the one to make this decision. */
  'DISCOVERY_ESCALATION',
] as const;

export type InterventionReason = (typeof INTERVENTION_REASONS)[number];

/** Which engine is asking. Shown to the operator, and decides how a resume proceeds. */
export type InterventionSource = 'replay' | 'discovery';

/**
 * What the person answering needs to know.
 *
 * Everything here is already safe to display: a capability name, a step id, a code, and a
 * sanitized URL. There is no field for an invocation value, a page body, a credential, or
 * anything a model wrote, because the operator UI renders whatever this carries and an
 * operator page is a screen people photograph.
 */
export interface InterventionContext {
  readonly source: InterventionSource;
  readonly reason: InterventionReason;
  /** The capability being replayed, or the goal being discovered. */
  readonly subject: string;
  /** Where the run stopped. Absent for a discovery run, which has no stored steps. */
  readonly stepId?: string;
  /** The Phase 5 or Phase 6 code that caused this, so the two records agree. */
  readonly code: string;
  /** One sentence a person can act on. Never a raw exception. */
  readonly detail: string;
}

/**
 * How the intervention ended.
 *
 * `resolved` means a person took control and handed it back; it is not a claim that the
 * problem is fixed. The engine still checks the application itself before continuing,
 * which is the whole reason this is three words rather than a boolean.
 */
export type InterventionOutcome =
  | { readonly status: 'resolved' }
  | { readonly status: 'aborted'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/** What the engine found when it looked at the application after control came back. */
export interface InterventionSettlement {
  readonly resumed: boolean;
  /** Why the run could not continue, when it could not. Never a raw exception. */
  readonly detail?: string;
}

export interface InterventionHandler {
  /**
   * Pauses the run and waits for a person.
   *
   * Resolves only once control has come back, which is what makes the pause real: the
   * engine is inside this await and is issuing nothing while it waits.
   */
  request(context: InterventionContext): Promise<InterventionOutcome>;

  /**
   * Reports whether the run could actually continue.
   *
   * Separate from `request` because a person handing control back is not the same as the
   * problem being solved, and only the engine can tell the difference: it is the one that
   * looks at the application afterwards. Without this the session would sit in `resuming`
   * forever while the run had already moved on or given up.
   */
  settle(settlement: InterventionSettlement): Promise<void>;
}
