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
