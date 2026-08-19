import type { SessionView } from '../handoff/index.js';

/**
 * The operator page, as a string.
 *
 * Server-rendered HTML with one small script, and no framework. The page shows five facts
 * and offers at most three buttons; a build step, a component library, and a client-side
 * router would all be machinery in service of that. It refreshes by reloading itself,
 * which is the simplest thing that keeps a paused session's state visible.
 *
 * The buttons are a convenience, not the authorization. Every transition is validated by
 * the session state machine on the server, so a stale page whose buttons are wrong gets an
 * error rather than an invalid transition.
 */

/** Escaped, because everything here is rendered into HTML and some of it is application text. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Title Case labels for the states, which are camelCase machine values internally. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  running: 'Running',
  waitingForHuman: 'Waiting For Human',
  humanControl: 'Under Human Control',
  resuming: 'Resuming',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
};

const OWNER_LABELS: Readonly<Record<string, string>> = {
  replay: 'Replay',
  discovery: 'Discovery',
  human: 'Human',
  none: 'Nobody',
};

function label(source: Readonly<Record<string, string>>, key: string): string {
  return source[key] ?? key;
}

function row(name: string, value: string): string {
  return `<div class="row"><div class="name">${escape(name)}</div><div class="value">${escape(value)}</div></div>`;
}

/**
 * Only the buttons the session can actually honour right now.
 *
 * A page that offers Resume Automation to a session nobody has taken control of invites an
 * operator to try something the server will refuse, and teaches them to ignore the page.
 */
function actions(session: SessionView): string {
  const buttons: string[] = [];
  if (session.state === 'waitingForHuman') {
    buttons.push('<button data-action="take-control" class="primary">Take Control</button>');
  }
  if (session.state === 'humanControl') {
    buttons.push('<button data-action="resume" class="primary">Resume Automation</button>');
  }
  if (session.state === 'waitingForHuman' || session.state === 'humanControl') {
    buttons.push('<button data-action="abort" class="danger">Abort Session</button>');
  }
  if (buttons.length === 0) {
    return '<p class="quiet">This Session Is No Longer Waiting For You.</p>';
  }
  return `<div class="actions">${buttons.join('')}</div>`;
}

function humanActions(session: SessionView): string {
  if (session.humanActions.length === 0) {
    return '<p class="quiet">Nothing Recorded Yet.</p>';
  }
  const items = session.humanActions
    .map((action) => {
      const target = action.target ?? 'the page';
      return `<li><span class="kind">${escape(action.actionType)}</span> ${escape(target)}</li>`;
    })
    .join('');
  return `<ul class="actions-list">${items}</ul>`;
}

function screenshot(session: SessionView): string {
  const file = session.intervention?.screenshot;
  if (file === undefined) {
    return '<p class="quiet">No Screenshot Was Captured.</p>';
  }
  return `<img src="/operator/${escape(session.id)}/screenshot" alt="The Screen That Stopped The Run" />`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 46rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 0.5rem; text-transform: none; }
  .sub { color: #666; margin: 0 0 1.5rem; }
  .row { display: grid; grid-template-columns: 12rem 1fr; padding: 0.4rem 0; border-bottom: 1px solid #8883; }
  .name { color: #666; }
  .value { font-weight: 500; word-break: break-word; }
  .actions { display: flex; gap: 0.75rem; margin: 1.5rem 0; }
  button { font: inherit; padding: 0.6rem 1.1rem; border-radius: 6px; border: 1px solid #8886; cursor: pointer; background: #8881; }
  button.primary { background: #2563eb; color: white; border-color: #2563eb; }
  button.danger { background: transparent; color: #b91c1c; border-color: #b91c1c88; }
  button[disabled] { opacity: 0.5; cursor: progress; }
  img { max-width: 100%; border: 1px solid #8883; border-radius: 6px; }
  .quiet { color: #777; }
  .actions-list { padding-left: 1.1rem; }
  .kind { display: inline-block; min-width: 4.5rem; color: #666; }
  .banner { padding: 0.75rem 1rem; border-radius: 6px; background: #f59e0b22; border: 1px solid #f59e0b66; margin-bottom: 1.5rem; }
`;

/**
 * The client half: three buttons and a reload.
 *
 * Deliberately not a state machine of its own. It posts, then reloads, so what the page
 * shows always came from the server rather than from a guess about what the post did.
 */
const SCRIPT = `
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (button === null) {
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch(location.pathname + '/' + button.dataset.action, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: 'The request failed.' }));
        alert(body.message ?? 'The request failed.');
      }
    } finally {
      location.reload();
    }
  });
`;

/** What the run is working on is a capability when replaying and a goal when discovering. */
function subjectLabel(session: SessionView): string {
  if (session.automation === 'replay') {
    return 'Capability';
  }
  return 'Goal';
}

function pausedBanner(session: SessionView): string {
  if (session.state === 'waitingForHuman' || session.state === 'humanControl') {
    return '<div class="banner">This Run Is Paused. Automation Will Not Act Until You Resume Or Abort.</div>';
  }
  return '';
}

export function renderOperatorPage(session: SessionView): string {
  const intervention = session.intervention;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Human Intervention</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Human Intervention</h1>
<p class="sub">Session ${escape(session.id)}</p>
${pausedBanner(session)}
${row(subjectLabel(session), session.subject)}
${row('Current Step', session.currentStepId ?? 'Not Applicable')}
${row('Reason', intervention?.detail ?? 'No Intervention Is Pending')}
${row('Code', intervention?.code ?? 'None')}
${row('Current URL', intervention?.url ?? 'Unknown')}
${row('Control Owner', label(OWNER_LABELS, session.controlOwner))}
${row('Current Status', label(STATE_LABELS, session.state))}
${row('Run ID', session.runId)}
${actions(session)}
<h2>Current Screenshot</h2>
${screenshot(session)}
<h2>Recorded Human Actions</h2>
${humanActions(session)}
<script>${SCRIPT}</script>
</body>
</html>`;
}
