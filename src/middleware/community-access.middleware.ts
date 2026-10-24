import { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { AuthenticatedRequest } from './auth.middleware';

/**
 * Shuts a blacklisted account out of the community. Always used *after*
 * requireAuth, on every community router: posts, comments and reviews, groups,
 * profiles and follows, reports, and mentions.
 *
 * A blacklist is a community ban, not an account ban — the bookstore stays open
 * to them — so this is per router rather than at sign-in. Read per request, not
 * from the token, so a blacklist bites on the next request rather than when
 * the token next refreshes, and lifting it does the same.
 *
 * 403 with a stable code, so the app can explain the restriction rather than
 * show a generic error.
 */
export function requireCommunityAccess(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  db.select({ blacklistedAt: users.blacklistedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
    .then(([row]) => {
      if (row?.blacklistedAt) {
        res.status(403).json({
          error: 'Your account can no longer use community features.',
          code: 'ACCOUNT_RESTRICTED',
        });
        return;
      }
      next();
    })
    .catch(next);
}
