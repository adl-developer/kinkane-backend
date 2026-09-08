# Hide session tokens from every log line

**Date:** 2026-09-08
**Commit:** [3b8bf38](https://adl.github.com/adl-developer/kinkane-backend/commit/3b8bf3895df1207fc8753b7ef07526c1e52e43a3)

## What changed

Session credentials are now redacted with `****` before any log line is
written. Two shapes are matched:

1. **JWT access tokens** — three base64url segments separated by dots
   (`x.y.z`), each segment at least 8 characters. That's the shape of a
   signed JWT and, thanks to the length floor, isn't confused with things
   like version numbers (`1.2.3`).
2. **Refresh tokens** — 80 lowercase hex characters. That's exactly what
   the auth service mints via `crypto.randomBytes(40).toString('hex')`.

The scrubber runs inside `src/lib/logger.ts` on the entire log entry
(message plus context plus any AsyncLocalStorage store), and walks nested
objects and arrays. A JWT that lands as a bare field value, embedded in a
`"Bearer …"` string in an error message, buried three levels deep in a
context object, or inside an array is redacted the same way.

## Why

Nothing was stopping a token from ending up in a log line. An error path
that echoed an inbound `Authorization` header, a `logger.debug({ req })`
during troubleshooting, or a Zod validation error carrying the offending
payload could all leak an access or refresh token into Render's log
explorer, which many operators can read.

Applying the scrub inside the logger itself — rather than at each call
site — means no future `logger.error` anywhere in the codebase can bypass
it by accident.

## Non-obvious decisions

- **Full redaction, not partial.** The replacement is `****`, not
  `eyJ…abc`. A partial-visible variant would leak useful bytes to anyone
  with log access without meaningfully helping debugging.
- **`scrubContext` returns a new structure rather than mutating in
  place.** The AsyncLocalStorage store is shared across every log line in
  a request, and mutating it would blur fields that other code still
  holds by reference.
- **Class instances pass through unchanged.** `JSON.stringify` would
  flatten them anyway, and scrubbing a class instance produces a plain
  object where the log destination expected the class's `toJSON` output.
- **Email-flow tokens (password reset, verification OTP, unsubscribe) are
  out of scope for now.** They use different shapes and aren't what "JWT
  / refresh token" covers; a follow-up can extend `SCRUB_RULES` with the
  same pattern.

## Verified

- TypeScript compilation clean (`npx tsc --noEmit`).
- Direct exercise of `scrubContext` and `scrubString` against:
  - A `"Bearer eyJhbGciOi….signaturepart.morestuff"` string inline in a
    message field — redacted.
  - A JWT as a top-level field value — redacted.
  - An 80-hex refresh token as a field value — redacted.
  - A UUID (`550e8400-e29b-41d4-a716-446655440000`) — left alone.
  - A version number (`1.2.3`) — left alone (segment length floor).
  - A nested object containing a JWT two levels deep — walked and
    redacted.
  - An array of tokens — walked and redacted element by element.
