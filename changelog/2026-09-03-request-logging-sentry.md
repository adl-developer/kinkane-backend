# Request logging, per-request ids, and Sentry error reporting

**Date:** 2026-09-03

## What changed

The server now records what it is doing, request by request, and reports
unhandled errors to Sentry. Three connected pieces:

### 1. One log line per request

A new middleware (`middleware/request-logger.middleware.ts`) is mounted before
the routes. When a response finishes it writes a single structured line:

```json
{ "level": "info", "message": "request", "requestId": "…",
  "method": "GET", "path": "/api/v1/books/:id", "status": 200,
  "durationMs": 12.4, "userId": 42 }
```

- `path` is the matched route **template** (`/books/:id`), not the concrete
  URL, so book ids and the like don't explode the log's cardinality. A request
  that matches no route (a 404) falls back to the raw path.
- The line's level tracks the outcome: 5xx logs at `error`, 4xx at `warn`,
  everything else at `info`.
- `userId` is included when the request was authenticated.

Before this, a request that succeeded left no trace at all — only requests that
threw were logged. This turns the logger into an actual audit trail of API
traffic.

### 2. A per-request id, threaded everywhere

Each request gets an id — taken from an inbound `X-Request-Id` header when it's
well-formed, otherwise freshly minted — and echoed back in the `X-Request-Id`
response header so a client (or an upstream proxy) can correlate.

The id is put into an `AsyncLocalStorage` context in the logger, so **every**
`logger.*` call made while that request is on the stack automatically carries
the `requestId` — including an error logged deep inside a service, with no need
to thread the id through every function call. That is what ties a stack trace
back to the request that caused it.

### 3. Log level filter (debug no longer ships to production)

`lib/logger.ts` gained a severity threshold. Left unconfigured it keeps `debug`
in development and starts at `info` everywhere else, so debug lines stop
shipping to production. `LOG_LEVEL=debug|info|warn|error` overrides it — e.g.
raise verbosity to trace a production issue, or set `warn` to quieten a noisy
environment.

### 4. Sentry

`lib/sentry.ts` initialises Sentry (via `instrument.ts`, imported first in
`server.ts` so it loads before the app graph). The global Express error handler
now reports unhandled errors — the real `Error` with its stack, tagged with the
`requestId` — to Sentry. Additionally, `logger.warn`/`logger.error` calls are
forwarded as Sentry messages, so the existing ~165 warn/error call sites become
searchable and alertable there.

## Configuration

New environment variables (all optional, documented in `.env.example`):

- `LOG_LEVEL` — `debug|info|warn|error`. Unset uses the dev/prod default above.
- `SENTRY_DSN` — unset disables Sentry entirely (no account needed for local or
  CI; nothing is sent). Set to the project DSN to turn it on.
- `SENTRY_TRACES_SAMPLE_RATE` — `0..1`, default `0` (errors only). Raise to
  sample performance transactions.

## Non-obvious decisions

- **Sentry init lives in its own `instrument.ts`, imported first.** ES module
  imports are evaluated before any statement in the importing module runs, so
  initialising Sentry in the body of `server.ts` would run *after* `./app` (and
  Express) had already loaded. A side-effecting module imported first is the
  only way to guarantee init happens before the app graph.
- **`logger` → `sentry` is a one-way edge.** `sentry.ts` deliberately does not
  import `logger` (logger imports it), to avoid a cycle; it only talks to the
  Sentry SDK.
- **Inbound `X-Request-Id` is validated, not trusted blindly.** Only a short
  `[\w-]` string is honoured; anything else is replaced with a minted UUID, so a
  client can't smuggle newlines or huge strings into our log lines.
- **The Stripe webhook is intentionally not wrapped** by the request logger — it
  is mounted before `express.json` with its own raw-body handling and must stay
  that way for signature verification.
- **Tracing defaults to off.** Errors-only Sentry adds no per-request overhead;
  performance sampling is opt-in via `SENTRY_TRACES_SAMPLE_RATE`.

## Out of scope

- Adding logging to the outbound Stripe/Resend/Firebase wrappers, and converting
  the remaining `console.*` call sites to the logger — separate follow-ups.
- No log aggregation/retention beyond Sentry and the platform's stdout capture.

## How it was verified

- `npx tsc --noEmit` clean.
- New test file `src/__tests__/request-logging.test.ts` (7 tests) covers: debug
  suppressed at `info`, `LOG_LEVEL=error` silencing lower levels, context
  threading via `runWithLogContext`, the `X-Request-Id` header, honouring and
  validating an inbound id, and 4xx→warn / 5xx→error summary levels.
- Manual smoke test against a live Express harness confirmed the id is echoed,
  a client-supplied id is honoured, and a downstream `logger` call inside a
  handler carries the `requestId`.
