import { Request, Response, NextFunction } from 'express';
import { isBlacklistedCached } from '../services/blocks.service';
import type { AuthenticatedRequest } from './auth.middleware';

/**
 * Shuts a blacklisted account out of the community. Always used *after*
 * requireAuth, on every community router: posts, comments and reviews, groups,
 * profiles and follows, reports, and mentions.
 *
 * Sign-in and refresh already refuse a blacklisted account and its sessions
 * are revoked, so this covers only the access token it still holds, for the
 * minutes until it expires. Answered from a one-minute per-instance cache
 * (isBlacklistedCached) rather than a query per request: the window it guards
 * is short, and every community request would otherwise pay for it.
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

  isBlacklistedCached(user.id)
    .then((blacklisted) => {
      if (blacklisted) {
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
