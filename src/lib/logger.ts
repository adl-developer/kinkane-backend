import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';
import { captureLog } from './sentry';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Context = Record<string, unknown>;

// Ordered by severity so a configured threshold can silence everything below it.
const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// The minimum level that gets written. Explicit LOG_LEVEL wins; otherwise
// development stays chatty (debug) and everything else — production included —
// starts at info, so debug lines no longer ship to production by default.
const threshold: Level =
  config.logLevel ?? (config.nodeEnv === 'development' ? 'debug' : 'info');

// Per-request context, seeded by the request logger and merged into every line
// written while that request is on the stack. This is how a requestId reaches a
// `logger.error` deep in a service without being threaded through every call.
const store = new AsyncLocalStorage<Context>();

/** Run `fn` with `context` attached to every log line it (transitively) emits. */
export function runWithLogContext<T>(context: Context, fn: () => T): T {
  return store.run(context, fn);
}

/** Merge fields into the current request's log context, if there is one. */
export function addLogContext(context: Context): void {
  const current = store.getStore();
  if (current) Object.assign(current, context);
}

function write(level: Level, message: string, context?: Context): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    ...store.getStore(),
    ...context,
  };
  const line = JSON.stringify(entry) + '\n';
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  // Forward warn/error to Sentry so the lines that matter become searchable and
  // alertable there too. A no-op when SENTRY_DSN is unset.
  if (level === 'error' || level === 'warn') {
    captureLog(level, message, { ...store.getStore(), ...context });
  }
}

export const logger = {
  debug: (message: string, context?: Context) => write('debug', message, context),
  info:  (message: string, context?: Context) => write('info',  message, context),
  warn:  (message: string, context?: Context) => write('warn',  message, context),
  error: (message: string, context?: Context) => write('error', message, context),
};
