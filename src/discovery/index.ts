/**
 * LLM-driven workflow discovery.
 *
 * This is the only part of the system with a model in its decision loop, and it depends
 * on the generic `LLMClient` rather than on any provider: nothing under this directory
 * imports an SDK, and nothing imports Playwright, so a run is composed by handing the
 * engine a client and a surface it cannot identify.
 *
 * Nothing under `replay/` may import from here. Replay executes a saved capability with
 * no model in the loop, which is enforced by an ESLint restriction and by
 * `tests/architecture.test.ts`.
 *
 * A successful run produces a `DiscoveryTrace`, not a capability artifact. Compiling one
 * into the other is Phase 8's work and is deliberately not started here.
 */
export {
  AGENT_ACTION_TYPES,
  agentActionSchema,
  agentDecisionSchema,
  describeAction,
  fingerprintAction,
  parseAgentDecision,
  type ActionDecision,
  type AgentAction,
  type AgentActionType,
  type AgentDecision,
  type AgentDecisionType,
  type CompleteDecision,
  type DecisionParse,
  type EscalateDecision,
} from './AgentDecision.js';
export {
  DiscoveryEngine,
  type DiscoveryEngineOptions,
  type DiscoveryRequest,
  type TargetApplication,
} from './DiscoveryEngine.js';
export {
  DISCOVERY_FAILURE_CODES,
  type DiscoveryEscalation,
  type DiscoveryFailure,
  type DiscoveryFailureCode,
  type DiscoveryFailureKind,
  type DiscoveryResult,
  type DiscoverySuccess,
} from './DiscoveryResult.js';
export {
  fingerprintObservation,
  summarizeObservation,
  type ActionOutcome,
  type DiscoveredValue,
  type DiscoveryInput,
  type DiscoveryTrace,
  type DiscoveryTraceEntry,
  type ObservationSummary,
} from './DiscoveryTrace.js';
export { DEFAULT_LOOP_LIMITS, LoopGuard, type LoopLimits, type LoopStop } from './LoopGuard.js';
export { DISCOVERY_SYSTEM_PROMPT } from './prompt.js';
