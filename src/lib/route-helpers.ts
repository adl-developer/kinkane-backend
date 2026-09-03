import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import type { Response, NextFunction, RequestHandler, Request } from 'express';
import { logger } from './logger';

export function parseId(raw: string, label: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 });
  }
  return id;
}

export const wrap =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as AuthenticatedRequest, res).catch(next);

/** An error carrying the HTTP response it wants, thrown from a service layer. */
export interface HttpError extends Error {
  statusCode?: number;
  /** Stable machine-readable identifier, e.g. 'OUT_OF_STOCK'. */
  code?: string;
  /** Extra fields merged into the response body — see the cart-changed 409. */
  details?: Record<string, unknown>;
}

/**
 * Like `wrap`, but turns a service-thrown `statusCode` into that response
 * instead of a blanket 500.
 *
 * Services in this codebase signal expected failures by throwing an Error with
 * a `statusCode` attached, and until now every controller re-implemented the
 * same try/catch to translate it. This does it once.
 *
 * That includes expected *5xx* — a 503 when Stripe is unconfigured, an exchange
 * rate is missing, or a parcel is too heavy for any service. Those carry a
 * curated, client-safe message and a `code`, so they are surfaced verbatim
 * rather than flattened into "Internal server error": a buyer told "this basket
 * is too heavy" can act on it, where a bare 500 looks like a site fault. A
 * surfaced 5xx is still logged here (at warn) so operators see it.
 *
 * Only an error with **no** `statusCode` is treated as unexpected and passed to
 * the global handler untouched, so it keeps its stack trace and returns a
 * generic message rather than leaking an internal error string to the client.
 */
export const wrapHttp =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as AuthenticatedRequest, res).catch((err: HttpError) => {
      if (!err.statusCode) {
        next(err);
        return;
      }

      if (err.statusCode >= 500) {
        logger.warn('Service returned an expected 5xx', {
          statusCode: err.statusCode,
          code: err.code,
          message: err.message,
        });
      }

      res.status(err.statusCode).json({
        error: err.message,
        ...(err.code && { code: err.code }),
        ...err.details,
      });
    });
