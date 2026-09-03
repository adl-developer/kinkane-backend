import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger, runWithLogContext, addLogContext } from '../lib/logger';
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
 * Logs one line per request and gives the request an id.
 *
 * Every log line emitted while the request is on the stack carries `requestId`
 * automatically (via the logger's async context), so an error thrown deep in a
 * service is tied back to the request that caused it without threading the id
 * through every function. On response finish, a summary line records method,
 * path, status and duration — turning the logger from occasional notes into an
 * actual audit trail of what the API is doing.
 *
 * Mounted before the routes but after body parsing; it does not read the body.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Trust an inbound id only if it looks sane; otherwise mint our own. This
  // stops a client from smuggling newlines or huge strings into our log lines.
  const inbound = req.header(REQUEST_ID_HEADER);
  const requestId =
    inbound && /^[\w-]{1,128}$/.test(inbound) ? inbound : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();

  runWithLogContext({ requestId }, () => {
    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      // req.route?.path is the matched template ('/books/:id'), which keeps ids
      // out of the log's cardinality; fall back to the raw path when unmatched
      // (a 404 has no route).
      const routePath = req.route?.path;
      const path =
        typeof routePath === 'string'
          ? `${req.baseUrl ?? ''}${routePath}`
          : req.originalUrl;

      // req.user is set by the auth middleware within this same async context.
      const userId = (req as AuthenticatedRequest).user?.id;
      if (userId !== undefined) addLogContext({ userId });

      const context = {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ...(userId !== undefined && { userId }),
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
