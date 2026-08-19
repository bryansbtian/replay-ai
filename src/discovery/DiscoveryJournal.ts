import type { EvidenceRecorder } from '../evidence/index.js';
import type { Logger } from '../logging/logger.js';
import type { PolicyDecision } from '../policy/index.js';

import type { AgentAction, AgentDecision } from './AgentDecision.js';
import { describeAction } from './AgentDecision.js';
import type { ObservationSummary } from './DiscoveryTrace.js';
import { describeDenial } from './policyGate.js';

/**
 * One call site per thing that happens in a discovery run, two sinks.
 *
 * The same arrangement replay uses, and for the same reason: a developer log and a
 * durable record must never disagree about what may be written down, and the way to make
 * that structural is to leave nowhere to write one without the other.
 *
 * What it refuses to carry is the interesting part. There is no method that takes a model
 * response, a prompt, a transcript, or an observation. A decision is recorded as its type,
 * its action shape, and the one-line summary the schema already bounded; a request is
 * recorded as the fact that it happened and what it cost. Nothing here can be handed a
 * provider response body, so no future call site can accidentally persist one.
 */
export interface DiscoveryJournalOptions {
  readonly logger: Logger;
  readonly evidence: EvidenceRecorder;
}

type JournalFields = Record<string, unknown>;

export class DiscoveryJournal {
  private readonly logger: Logger;
  private readonly evidence: EvidenceRecorder;

  constructor(options: DiscoveryJournalOptions) {
    this.logger = options.logger;
    this.evidence = options.evidence;
  }

  /**
   * The run's own start, as a log line only.
   *
   * The recorder already writes a `discovery_started` event when the composition root
   * hands it the run's identity, so emitting one here would put the same moment in the
   * stream twice and leave a reader wondering which was authoritative.
   */
  started(fields: JournalFields): void {
    this.logger.info('Discovery Started', fields);
  }

  async observed(step: number, summary: ObservationSummary): Promise<void> {
    const fields = {
      step,
      url: summary.url,
      title: summary.title,
      controlCount: summary.controlCount,
      // The text itself is never recorded. Its length and the state fingerprint are what
      // a reader needs to follow the run, and they cannot carry somebody's account data.
      textLength: summary.textLength,
      state: summary.fingerprint,
    };
    this.logger.debug('Observation Captured', fields);
    await this.evidence.recordEvent({ event: 'observation_captured', fields });
  }

  async modelRequested(step: number, fields: JournalFields): Promise<void> {
    const record = { step, ...fields };
    this.logger.debug('Model Request Started', record);
    await this.evidence.recordEvent({ event: 'model_request', fields: record });
  }

  /**
   * Records what the model decided.
   *
   * The fields are fixed and few: which kind of decision, which action it names, and the
   * summary the model wrote for a person. The response text is not among them, which is
   * how "no raw provider output in evidence" is enforced rather than remembered.
   */
  async decided(step: number, decision: AgentDecision, cost: JournalFields): Promise<void> {
    const fields: JournalFields = { step, decisionType: decision.type, ...cost };
    if (decision.type === 'action') {
      fields['actionType'] = decision.action.type;
      fields['action'] = describeAction(decision.action);
      fields['summary'] = decision.summary;
    }
    if (decision.type === 'complete') {
      fields['summary'] = decision.summary;
      // Names only. The values are the run's result and are returned to the caller, not
      // written into a record that outlives it.
      fields['outputNames'] = Object.keys(decision.outputs);
    }
    if (decision.type === 'escalate') {
      fields['reason'] = decision.reason;
    }

    this.logger.info('Model Decision Received', fields);
    await this.evidence.recordEvent({ event: 'model_decision', fields });
  }

  async decisionRejected(step: number, issue: string): Promise<void> {
    const fields = { step, issue };
    this.logger.error('Model Decision Rejected', fields);
    await this.evidence.recordEvent({ event: 'model_response_invalid', fields });
  }

  /**
   * Records what policy was asked and what it answered, for every action rather than only
   * the refused ones. A record that lists only refusals cannot tell an action that was
   * permitted from one nobody checked.
   */
  async policyEvaluated(
    step: number,
    action: AgentAction,
    decision: PolicyDecision,
  ): Promise<void> {
    const base = { step, actionType: action.type, outcome: decision.outcome };
    if (decision.outcome === 'allow') {
      this.logger.debug('Policy Allowed', base);
      await this.evidence.recordEvent({ event: 'policy_evaluated', fields: base });
      return;
    }

    const denial = { ...base, code: decision.code, reason: describeDenial(decision) };
    this.logger.warn('Policy Blocked', denial);
    await this.evidence.recordEvent({ event: 'policy_evaluated', fields: base });
    await this.evidence.recordEvent({ event: 'policy_blocked', fields: denial });
  }

  async actionStarted(step: number, action: AgentAction, budgetMs: number): Promise<void> {
    const fields = { step, actionType: action.type, action: describeAction(action), budgetMs };
    this.logger.info('Action Started', fields);
    await this.evidence.recordEvent({ event: 'action_started', fields });
  }

  async actionCompleted(step: number, action: AgentAction, durationMs: number): Promise<void> {
    const fields = { step, actionType: action.type, durationMs };
    this.logger.info('Action Completed', fields);
    await this.evidence.recordEvent({ event: 'action_completed', fields });
  }

  async actionFailed(step: number, fields: JournalFields): Promise<void> {
    const record = { step, ...fields };
    this.logger.warn('Action Failed', record);
    await this.evidence.recordEvent({ event: 'action_failed', fields: record });
  }

  async goalCompleted(fields: JournalFields): Promise<void> {
    this.logger.info('Goal Completed', fields);
    await this.evidence.recordEvent({ event: 'goal_completed', fields });
  }

  async escalationRequested(fields: JournalFields): Promise<void> {
    this.logger.warn('Escalation Requested', fields);
    await this.evidence.recordEvent({ event: 'escalation_requested', fields });
  }

  async stopped(fields: JournalFields): Promise<void> {
    this.logger.warn('Discovery Stopped', fields);
    await this.evidence.recordEvent({ event: 'discovery_stopped', fields });
  }
}
