import type { InterventionReason, InterventionSource } from '../execution/index.js';

/**
 * What a person is shown when a run asks for them.
 *
 * Every field is already safe to render. There is no invocation value, no page body, no
 * cookie, no header, and nothing a model produced beyond a bounded summary, because an
 * operator page is a screen somebody photographs and pastes into a ticket.
 *
 * The screenshot is a reference rather than an image. The Phase 6 recorder already stores
 * captures under the run's own directory and hands back a file name, so the intervention
 * points at that instead of growing a second copy of the same picture.
 */
export interface InterventionRequest {
  readonly id: string;
  readonly sessionId: string;
  /** The run this happened in. The same id the evidence directory is named for. */
  readonly runId: string;
  readonly source: InterventionSource;
  readonly reason: InterventionReason;
  /** The capability being replayed, or the goal being discovered. */
  readonly subject: string;
  /** Where the run stopped. Absent for discovery, which has no stored steps. */
  readonly stepId?: string;
  /** The Phase 5 or Phase 6 code that caused it, so both records name the same thing. */
  readonly code: string;
  /** One sentence a person can act on. */
  readonly detail: string;
  /** Sanitized location at the moment the run stopped. */
  readonly url: string;
  /** File name under the run's `screenshots/` directory, when one could be taken. */
  readonly screenshot?: string;
  readonly requestedAt: string;
}
