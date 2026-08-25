import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../lib/logger';
import { entitlementsService } from '../services/subscriptions/entitlements.service';
import type { AuthenticatedRequest } from './auth.middleware';

/**
 * Gates a route behind Kinkané Plus. Always used *after* requireAuth.
 *
 * Responds **402 Payment Required**, not 403. The client has to be able to tell
 * "you need to subscribe" apart from "this isn't yours" without parsing prose,
 * and those are the only two ways a request can be forbidden here. The body
 * shape is part of the contract — the app keys its paywall off `code`.
 *
 * Controlled by GATING_ENABLED so the gate can ship dark and be turned on (or
 * reverted) without a deploy. When it's off, every check passes and the reason
 * is logged once per request at debug level rather than silently.
 */
export function requirePlus(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!config.gatingEnabled) {
    next();
    return;
  }

  entitlementsService
    .get(user.id)
    .then((entitlement) => {
      if (entitlement.isPlus) {
        next();
        return;
      }

      res.status(402).json({
        error: 'Kinkané Plus is required for this feature',
        code: 'PLUS_REQUIRED',
        tier: entitlement.tier,
        status: entitlement.status,
        upgradeUrl: `${config.appUrl}/account/subscription`,
      });
    })
    .catch((err: Error) => {
      // Failing open: if entitlement can't be read, the database or Redis is
      // in trouble, and locking every paying subscriber out of the features
      // they bought is the worse of the two failures.
      logger.error('Entitlement check failed — allowing the request through', {
        userId: user.id,
        path: req.originalUrl,
        error: err.message,
      });
      next();
    });
}

/**
 * Attaches the entitlement to the request without enforcing it, for endpoints
 * that stay open but shape their response by tier.
 */
export function attachEntitlement(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    next();
    return;
  }

  entitlementsService
    .get(user.id)
    .then((entitlement) => {
      (req as AuthenticatedRequest & { entitlement?: unknown }).entitlement = entitlement;
      next();
    })
    .catch(() => next());
}
