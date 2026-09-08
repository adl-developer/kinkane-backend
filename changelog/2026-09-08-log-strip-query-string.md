# Drop query strings from the request log so tokens can't sneak in

**Date:** 2026-09-08
**Commit:** [0666da6](https://adl.github.com/adl-developer/kinkane-backend/commit/0666da6db53310ec139abcf80ebdb6d3ebbfa46b)

## What changed

The request-logger middleware no longer records the query portion of a
URL in the `path` field of a request log line:

- **Matched routes** (`GET /books/:id`) already used the route template,
  which never had a query attached. Behaviour unchanged there.
- **Unmatched routes** (any 404) used to fall back to `req.originalUrl`
  verbatim, which included the entire query string. That fallback now
  strips at the first `?`, so `/anything?token=…` is logged as
  `/anything`.

## Why

An unmatched request whose URL contained a token in the query string —
`?token=…`, `?otp=…`, `?code=…` — was landing that token in the log line
in plain text. This mostly showed up as noise from misconfigured clients
or link previewers hitting the wrong path, but the shape of the fallback
meant any caller could put arbitrary sensitive query params in Render's
log explorer just by hitting a 404.

The query adds nothing useful to a request log — a matched route's
template is what belongs there, and a 404 only needs the path — so
dropping it costs nothing operationally and closes the leak.

## Non-obvious decisions

- **Strip the query even for matched routes conceptually.** In practice
  the matched branch was already using `req.route.path`, so no query was
  present; the code and comment now say why explicitly, so a future
  refactor doesn't accidentally reintroduce `req.originalUrl` on the
  matched path.
- **This layers with the log scrubber landed in the previous commit.**
  Even if a token did somehow reach the log context via another route, it
  would still be redacted. Belt and braces.

## Verified

- TypeScript compilation clean (`npx tsc --noEmit`).
- The two updated unit tests in
  `src/__tests__/request-logging.test.ts` pass:
  - A matched route hit with `?limit=20&secret=xyz` logs `path: "/hit"`.
  - An unmatched route hit with `?token=…` logs `path: "/miss"` — the
    token is absent from the line.
