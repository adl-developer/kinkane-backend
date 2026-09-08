import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger, runWithLogContext, addLogContext } from '../lib/logger';
import { config } from '../config';
import type { AuthenticatedRequest } from './auth.middleware';

// The header we both honour on the way in and echo on the way out, so a client
// (or an upstream proxy) can correlate its request with our logs, and a caller
// can quote the id when reporting a problem.
const REQUEST_ID_HEADER = 'x-request-id';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * How much of one payload is kept, in characters of its JSON form.
 *
 * A cap rather than the whole thing because a 50kb bulk import body (the
 * express.json limit) in every log line buries the requests either side of it
 * and costs real money in an ingest-priced aggregator. 2kb is comfortably more
 * than any hand-written request this API takes.
 */
const MAX_PAYLOAD_CHARS = 2_048;

/**
 * Returns the payload to log, or undefined when there is nothing worth logging.
 *
 * Empty objects are dropped rather than logged as `{}`: a GET with no query
 * string and no route params would otherwise add two dead fields to every line.
 *
 * The value is returned as a structure, not a string — the logger's scrubber
 * walks it field by field, and pre-stringifying here would flatten it into one
 * opaque blob that only the pattern rules could reach into.
 */
function payload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  if (Object.keys(value as object).length === 0) return undefined;

  // Measured on the serialised form because that is what actually lands in the
  // log. Oversized payloads are truncated to a quotable prefix rather than
  // dropped — the first 2kb usually names the endpoint's shape, which is the
  // part being debugged.
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    // A body that cannot be serialised (a cycle, a BigInt) must not take the
    // request's log line down with it.
    return '[unserialisable]';
  }

  if (json.length <= MAX_PAYLOAD_CHARS) return value;
  return `${json.slice(0, MAX_PAYLOAD_CHARS)}… [truncated, ${json.length} chars]`;
}

/**
 * Logs one line per request and gives the request an id.
 *
 * Every log line emitted while the request is on the stack carries `requestId`
 * automatically (via the logger's async context), so an error thrown deep in a
 * service is tied back to the request that caused it without threading the id
 * through every function. On response finish, a summary line records method,
 * path, status and duration — turning the logger from occasional notes into an
 * actual audit trail of what the API is doing.
 *
 * Mounted before the routes but after body parsing, so `req.body` is already
 * a parsed object by the time the summary line is written.
 *
 * With `LOG_REQUEST_PAYLOADS` on (the default in development), that line also
 * carries the request's `body`, `query` and route `params`. Everything in them
 * passes through the logger's scrubber first, which redacts by field name as
 * well as by pattern — see lib/log-scrubber for what that does and does not
 * cover, and config for why this is off outside development.
 */

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Trust an inbound id only for correlation, not identity. A well-formed
  // one is prefixed with `client-` so a caller can't spoof a server-minted
  // id (say, one another user's request produced earlier) — the prefix
  // makes "supplied by the caller" visible at a glance in every log line
  // it reaches and stops the incident-forensics muddying that trusting
  // inbound ids without a marker allows.
  //
  // The regex on the raw value also keeps a caller from smuggling newlines
  // or huge strings into our log lines.
  const inbound = req.header(REQUEST_ID_HEADER);
  const requestId =
    inbound && /^[\w-]{1,128}$/.test(inbound) ? `client-${inbound}` : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();

  runWithLogContext({ requestId }, () => {
    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      // req.route?.path is the matched template ('/books/:id'), which keeps ids
      // out of the log's cardinality; fall back to the raw path when unmatched
      // (a 404 has no route). Either way the query string is stripped — an
      // unmatched /whatever?token=... would otherwise land the whole token in
      // the log, and even matched paths gain nothing from having their query
      // repeated verbatim on top of the route template.
      const routePath = req.route?.path;
      const path =
        typeof routePath === 'string'
          ? `${req.baseUrl ?? ''}${routePath}`
          : req.originalUrl.split('?', 1)[0];

      // req.user is set by the auth middleware within this same async context.
      const userId = (req as AuthenticatedRequest).user?.id;
      if (userId !== undefined) addLogContext({ userId });

      // Read at finish rather than at entry so `params` is populated — the
      // route has been matched by now, and before it there is nothing to read.
      // `body` is unchanged by routing, and reading a reference to it here
      // rather than copying it keeps the hot path free of a clone that only
      // the log would use.
      const payloads: Record<string, unknown> = {};
      if (config.logRequestPayloads) {
        for (const [field, value] of [
          ['body', req.body],
          ['query', req.query],
          ['params', req.params],
        ] as const) {
          const logged = payload(value);
          if (logged !== undefined) payloads[field] = logged;
        }
      }

      const context = {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ...(userId !== undefined && { userId }),
        ...payloads,
      };

      // A 5xx is our fault, a 4xx is the caller's, everything else is routine.
      if (res.statusCode >= 500) {
        logger.error('request', context);
      } else if (res.statusCode >= 400) {
        logger.warn('request', context);
      } else {
        logger.info('request', context);
      }
    });

    next();
  });
}
