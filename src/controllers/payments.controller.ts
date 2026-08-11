import { Response } from 'express';
import { paymentsService } from '../services/payments.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

export const paymentsController = {
  /**
   * GET /api/v1/payments/:reference
   *
   * Confirms whether the payment behind a reference succeeded. Works for both
   * kinds of Stripe payment — a Kinkané Plus subscription and a book order —
   * because both mint their reference from the same place.
   *
   * 404 covers both "no such reference" and "not yours", deliberately: ownership
   * is part of the lookup, so this can't be used to discover whether someone
   * else's reference exists.
   */
  async confirm(req: AuthenticatedRequest, res: Response): Promise<void> {
    const reference = String(req.params.reference ?? '').trim();

    // Cheap shape check before touching the database — the reference is a
    // path segment and will otherwise be whatever anyone types.
    if (!/^KP-[0-9A-Za-z]{6,32}$/.test(reference)) {
      res.status(400).json({ error: 'Invalid payment reference' });
      return;
    }

    const confirmation = await paymentsService.confirm(reference, req.user.id);

    if (!confirmation) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    res.status(200).json(confirmation);
  },
};
