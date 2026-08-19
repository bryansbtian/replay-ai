/**
 * Human handoff: how a run pauses, what it hands a person, and how control comes back.
 *
 * The domain knows about sessions, ownership, and evidence. It does not know about
 * Playwright, a model, or an HTTP server: it is given a surface it cannot identify and asks
 * whether that surface can be operated by a person, and the operator server sits above it
 * translating requests into these calls.
 *
 * Replay and discovery do not import this module. They depend on `execution/intervention`,
 * which is one interface with two methods, so neither engine can be made to care whether a
 * person was reachable.
 */
export {
  AutomationSession,
  CONTROL_OWNERS,
  ControlOwnershipError,
  InvalidSessionTransitionError,
  SESSION_STATES,
  type AutomationSessionOptions,
  type ControlOwner,
  type RecordedHumanAction,
  type SessionState,
  type SessionView,
} from './AutomationSession.js';
export {
  DEFAULT_INTERVENTION_TIMEOUT_MS,
  HandoffCoordinator,
  type HandoffCoordinatorOptions,
} from './HandoffCoordinator.js';
export type { InterventionRequest } from './InterventionRequest.js';
export { SessionNotFoundError, SessionRegistry } from './SessionRegistry.js';
