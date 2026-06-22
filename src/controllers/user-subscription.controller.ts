import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logger } from '../lib/logger';

export const userSubscriptionController = {
  /**
   * POST /api/v1/user/subscription/upgrade
   * Stub until Stripe is wired up. Returns a pending status so the client
   * has a stable contract to integrate against ahead of payment processing.
   */
  async upgrade(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      logger.info('Subscription upgrade requested (stub — no payment processing yet)', {
        userId: req.user.id,
      });
      res.status(200).json({ status: 'pending' });
    } catch (err: unknown) {
      logger.error('Unexpected error handling subscription upgrade', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
