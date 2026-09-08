# Harden the log scrubber against three coverage gaps

**Date:** 2026-09-08

## What changed

Three related coverage holes in the walker introduced with the
[log token scrubber](2026-09-08-log-token-scrubber.md) are closed.

1. **Version and build strings are no longer scrubbed.** The JWT pattern
   used to match any three dot-separated base64url-safe segments — which
   swept up deploy stamps like `20260101.abc12345.f00dcafe`. The first
   segment must now begin with `eyJ`, the base64 prefix every signed JWT
   header decodes to, so build strings and version tags stay readable
   while every real JWT keeps being redacted.
2. **Tokens buried inside non-literal objects are redacted.** The walker
   only entered plain object literals (`value.constructor === Object`).
   Everything else — an `Error` and its `cause` chain, a wrapper
   library's carrier class, `Object.create(null)` (which is what
   Express 5 uses for `req.query`) — passed through unchanged. The
   walker now enters any non-null object with own enumerable string
   keys.
3. **Cyclic values no longer blow the stack.** A `WeakSet` threads
   through the recursion and any repeat visit is replaced with
   `[Circular]`. Before this branch's original scrubber commit, the
   `JSON.stringify` step in the logger caught cycles with a
   TypeError — this restores the same graceful outcome the walker was
   otherwise regressing.

## Why

Each hole undermined the redaction guarantee the scrubber exists to
provide.

- Redacting a deploy stamp made release/build logs harder to read
  without helping security.
- Only walking plain objects meant a JWT set on an Error's `cause`, or
  in a null-prototype `req.query`, would land in the log verbatim
  despite the scrubber running over the same entry.
- Passing a cyclic value would crash the whole log call — every Express
  `req` is one (`req.res.req === req`), so a future
  `logger.error('...', { req })` was one edit away from causing an
  outage on the log path itself.

## Non-obvious decisions

- **`eyJ` anchor rather than a longer segment floor.** Increasing the
  minimum segment length would still let long build tags match; the
  `eyJ` anchor is what excludes non-JWTs directly. It works because a
  signed JWT header always encodes to JSON starting with `{"`, whose
  base64 encoding always begins `eyJ`.
- **`[Circular]` written as a plain string.** A bare marker looks like
  a JSON serialiser trace to a human reader and contains no characters
  that could match another scrub rule.
- **Walker enters any non-null object.** `typeof value === 'object' &&
  !Array.isArray(value)` catches Error, Map/Set-like carriers,
  null-prototype objects, and class instances alike. Own enumerable
  keys only (via `Object.entries`), so prototype-inherited fields and
  throwing getters are left alone.

## Verified

- TypeScript compilation clean (`npx tsc --noEmit`).
- New unit-test suite in `src/__tests__/log-scrubber.test.ts`, 12
  cases, all passing:
  - Real JWTs (in `Bearer ...` strings, in `token=...&other=x`)
    redacted.
  - Refresh tokens (80 lowercase hex) redacted.
  - Build stamps (`20260101.abc12345.f00dcafe`) and semver strings
    (`2.1.0-beta.1`) left alone.
  - UUIDs, 64-char SHA-256, and uppercase 80-hex left alone.
  - Nested plain objects walked.
  - Class instances, null-prototype objects, and Error `message`/`stack`
    walked and their embedded tokens redacted.
  - Cyclic object → `{ name: 'foo', self: '[Circular]' }` with no
    throw.
  - Cyclic array → `['[Circular]']` with no throw.
  - Primitives (number, boolean, null, undefined) untouched.
