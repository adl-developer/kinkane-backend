import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { userSubscriptionController } from '../controllers/user-subscription.controller';

const router = Router();

/**
 * POST /api/v1/user/subscription/upgrade
 *
 * Stub endpoint for the "Upgrade to unlock" flow. Stripe is not wired up yet —
 * this exists so the client has a stable contract to call ahead of payment
 * integration. Replace the body with real checkout-session creation once
 * Stripe is connected.
 *
 * Returns 200: { status: 'pending' }
 * Errors: 401 unauthenticated
 */
router.post('/upgrade', requireAuth, (req: Request, res: Response) =>
  userSubscriptionController.upgrade(req as AuthenticatedRequest, res),
);

export default router;
