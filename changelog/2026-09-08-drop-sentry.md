# Drop Sentry and rely on Render's log explorer instead

**Date:** 2026-09-08
**Commit:** [c34331d](https://adl.github.com/adl-developer/kinkane-backend/commit/c34331d60b9173adee303301779e691ba6890631)

## What changed

Sentry is gone. The `@sentry/node` dependency, the `src/lib/sentry.ts`
bridge, and the `src/instrument.ts` bootstrap file have all been removed,
along with the `SENTRY_DSN` and `SENTRY_TRACES_SAMPLE_RATE` environment
variables. `src/lib/logger.ts` no longer forwards warn/error lines
anywhere, and the global Express error handler in `src/app.ts` no longer
calls `captureError`.

Logs continue to go to `stdout` (info/debug) and `stderr` (warn/error) as
JSON, which is where Render's log explorer picks them up.

## Why

Every warn and error line was being sent to Sentry on top of the process
log, which had two problems:

1. **Noise.** Routine 4xx traffic — expired tokens, mistyped URLs,
   invalid params — was flooding the destination alongside real bugs. The
   signal-to-noise ratio made the tool less useful than reading Render's
   log explorer directly.
2. **Un-scrubbed PII.** The bridge attached the caller's user id (and
   whatever else was in the log context) to every captured event with no
   scrubber configured — a privacy exposure with no operational upside
   given the noise problem above.

Render already collects the same lines, keeps them searchable, and lets us
alert on error rate. Running a second destination in parallel wasn't
paying for itself.

## Non-obvious decisions

- **No replacement error reporter.** Deliberate. If we later want
  structured error tracking we'll re-evaluate the options at that point;
  Render's log explorer is enough for now.
- **`src/server.ts` no longer imports `./instrument` first.** That import
  only existed because Sentry required initialising before the app's
  module graph loaded. Nothing else needed the "before everything" slot,
  so the file was deleted rather than left as a no-op.
- **Error handler still logs at warn for tagged failures.** The comment
  in `app.ts` that used to say "not reported to Sentry" is now "logged at
  warn only" — same behaviour, cleaner reason.

## Verified

- TypeScript compilation clean (`npx tsc --noEmit`).
