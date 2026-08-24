import { Request, Response, NextFunction } from 'express';
import { adminAuthService } from '../services/admin/auth.service';
import type { Admin } from '../db/schema';

export interface AdminRequest extends Request {
  admin: Admin;
}

/**
 * Guards every admin-console endpoint.
 *
 * Distinct from `requireAdminToken` in app.ts, which is a single static bearer
 * shared by the machine-facing surfaces (Bull Board, the Gardners dropship
 * routes, the referral corrections). That one stays as it is: it authenticates
 * a deployment, not a person. This one authenticates a person, and is the only
 * thing that may sit in front of an endpoint that can blacklist a customer or
 * export the customer list.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    (req as AdminRequest).admin = await adminAuthService.verify(header.slice(7));
    next();
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    res.status(e.statusCode ?? 401).json({ error: e.message, code: e.code });
  }
}
