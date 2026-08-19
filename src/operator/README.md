# operator

The local operator interface: one server-rendered page and four routes.

```text
GET  /operator/:sessionId              the page
GET  /operator/:sessionId/session      the session as JSON
GET  /operator/:sessionId/screenshot   the capture taken when the run stopped
POST /operator/:sessionId/take-control
POST /operator/:sessionId/resume
POST /operator/:sessionId/abort
```

Depends on `handoff` and `logging`, and on nothing that executes anything. It holds no replay
logic, makes no policy decision, and never touches a browser object: each route looks a
session up and calls one method on its coordinator, and the session state machine decides
whether that was allowed. The buttons on the page are a convenience; the server is the
authorization.

Bound to `127.0.0.1`. Manual control is the visible browser window rather than a streamed
one, which is what keeps the same-session guarantee real without remote infrastructure.
Production operator access would need authentication and authorization; there is none here.
