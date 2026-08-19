import type { Page } from 'playwright';

import { sanitizeUrl } from '../../redaction.js';
import type { HumanAction } from '../types.js';

/**
 * Watching what a person does to the live page, while they do it.
 *
 * The mechanism is deliberately the smallest real one. Listeners are attached to the page
 * the automation was already driving, so a person operating the visible browser window is
 * operating the same session: same context, same cookies, same history, same half-filled
 * form. Nothing is opened and nothing is proxied.
 *
 * What it can see is honestly limited, and the limitation is the point of the comments
 * below. A person clicking a button produces a DOM event, not the semantic target
 * automation works in, so what is recorded is the best label the element offered. This is
 * evidence that an intervention happened and roughly what it touched. It is not a recording
 * that could be compiled into a workflow, and Phase 8 is deliberately not fed by it.
 */

/** The function name the page calls back through. Prefixed so it cannot collide. */
const BINDING = '__replayAiHumanAction';

/**
 * Attached to the page, and to every page it becomes.
 *
 * Listens on the capture phase at the document, so it sees events before the application's
 * own handlers can stop them propagating. `input` rather than `change` for typing, because
 * the intent is to know that somebody typed into a field, not what they typed.
 */
const LISTENER_SCRIPT = `(() => {
  if (window.__replayAiHumanControlAttached) {
    return;
  }
  window.__replayAiHumanControlAttached = true;

  const describe = (element) => {
    if (element === null || element === undefined) {
      return {};
    }
    const label =
      element.getAttribute?.('aria-label') ??
      element.labels?.[0]?.textContent ??
      element.getAttribute?.('name') ??
      element.getAttribute?.('placeholder') ??
      element.textContent;
    const role = element.getAttribute?.('role') ?? element.tagName?.toLowerCase();
    const trimmed = typeof label === 'string' ? label.replace(/\\s+/g, ' ').trim() : '';
    return { target: trimmed.slice(0, 80), role };
  };

  const send = (actionType, element) => {
    try {
      const described = describe(element);
      window.${BINDING}({ actionType, target: described.target, role: described.role });
    } catch {
      // A page that has torn down the binding is not a reason to break the page.
    }
  };

  document.addEventListener('click', (event) => { send('click', event.target); }, true);
  document.addEventListener('input', (event) => { send('fill', event.target); }, true);
})();`;

export interface HumanControlSession {
  /** Stops listening. The page itself is untouched, which is what lets the run continue. */
  stop(): Promise<void>;
}

/**
 * Starts recording what a person does to `page`.
 *
 * The init script covers pages the person navigates to; the immediate evaluate covers the
 * one already on screen, which is usually the one that matters because it is the state that
 * stopped the run.
 */
export async function beginHumanControl(
  page: Page,
  onAction: (action: HumanAction) => void,
): Promise<HumanControlSession> {
  const emit = (actionType: HumanAction['actionType'], detail: Partial<HumanAction>): void => {
    const action: HumanAction = {
      actionType,
      url: sanitizeUrl(page.url()),
      at: new Date().toISOString(),
      ...(detail.target !== undefined && detail.target !== '' && { target: detail.target }),
      ...(detail.role !== undefined && { role: detail.role }),
    };
    onAction(action);
  };

  await page.exposeFunction(BINDING, (payload: unknown) => {
    const detail = payload as { actionType?: string; target?: string; role?: string };
    const actionType = detail.actionType;
    if (actionType !== 'click' && actionType !== 'fill') {
      return;
    }
    // The value the person typed is never read out of the event. Only the fact that a
    // field was filled and which field it was.
    emit(actionType, {
      ...(detail.target !== undefined && { target: detail.target }),
      ...(detail.role !== undefined && { role: detail.role }),
    });
  });

  const onNavigated = (): void => {
    emit('navigate', {});
  };
  page.on('framenavigated', onNavigated);

  const script = await page.addInitScript(LISTENER_SCRIPT).then(() => LISTENER_SCRIPT);
  await page.evaluate(script).catch(() => {
    // A page mid-navigation has nothing to attach to yet; the init script covers the one
    // that arrives next, so this is a missed first click rather than a broken handoff.
  });

  return {
    async stop(): Promise<void> {
      page.off('framenavigated', onNavigated);
      // The binding and the init script stay on the page. Removing them would need a
      // reload, and reloading the application in the middle of an intervention would throw
      // away the very state the person just fixed.
      await Promise.resolve();
    },
  };
}
