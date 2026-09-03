import * as Sentry from '@sentry/node';
import { config } from '../config';

// Deliberately NOT importing ./logger here: logger imports this module, so a
// back-edge would be a cycle. This file only ever talks to the Sentry SDK.

let enabled = false;

/**
 * Initialise Sentry once, at process start, before the app is required.
 *
 * A no-op when SENTRY_DSN is unset — local and test runs need no account and
 * pay no cost. Tracing defaults to off (errors only): SENTRY_TRACES_SAMPLE_RATE
 * turns on performance sampling when a deployment actually wants it.
 */
export function initSentry(): void {
  if (!config.sentry.dsn) return;

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * Capture an unhandled error with request context attached. Called from the
 * global Express error handler, where the real Error object is still in hand.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Bridge for logger warn/error lines that are not thrown Errors. Keeps the
 * existing `logger.error('message', { ... })` call sites working while making
 * them visible in Sentry.
 */
export function captureLog(
  level: 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  if (!enabled) return;
  // Sentry's severity vocabulary uses 'warning', not 'warn'.
  const severity = level === 'warn' ? 'warning' : 'error';
  Sentry.captureMessage(message, { level: severity, extra: context });
}
