import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import type { Response, NextFunction, RequestHandler, Request } from 'express';

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
 * Anything without a `statusCode`, or with a 5xx one, is passed to the global
 * handler untouched: an unexpected failure must keep its stack trace and its
 * generic client-facing message rather than leaking an internal error string.
 */
export const wrapHttp =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as AuthenticatedRequest, res).catch((err: HttpError) => {
      if (!err.statusCode || err.statusCode >= 500) {
        next(err);
        return;
      }

      res.status(err.statusCode).json({
        error: err.message,
        ...(err.code && { code: err.code }),
        ...err.details,
      });
    });
