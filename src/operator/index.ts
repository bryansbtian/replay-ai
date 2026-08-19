/**
 * The local operator interface.
 *
 * One server-rendered page and four routes. It depends on the handoff domain and on
 * nothing else that executes anything: it holds no replay logic, makes no policy decision,
 * and never touches a browser object. Each route looks a session up and calls one method
 * on its coordinator, and the session state machine decides whether that was allowed.
 */
export { renderOperatorPage } from './page.js';
export {
  startOperatorServer,
  type OperatorServerOptions,
  type RunningOperatorServer,
} from './server.js';
