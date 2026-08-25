import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { paymentConfirmLimiter } from '../middleware/rate-limit.middleware';
import { paymentsController } from '../controllers/payments.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/v1/payments/:reference
 *
 * Confirms a payment the client started earlier. The reference is the one
 * returned alongside the Stripe URL when the checkout session was created —
 * the same shape whether the user was buying a subscription or books, so the
 * app stores one string and never branches on payment type.
 *
 * Reads our record first and falls back to asking Stripe directly while the
 * payment is still pending, because the user returns from the Stripe page
 * before the webhook arrives. That means the first call usually gets a
 * definitive answer rather than a "pending" the client has to poll through.
 *
 * `paid` is the field to branch on; `status` carries the detail.
 *
 * Params: reference — e.g. KP-7K3M9QXV2TB4
 * Returns 200: { reference, kind, status, paid, amountCents, currency, orderId, paidAt, reason }
 *   status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
 *   kind:   'subscription' | 'order'
 * Errors: 400 malformed reference | 401 unauthenticated | 404 unknown reference, or not the caller's |
 *         429 polled too fast (60/min — see paymentConfirmLimiter)
 */
router.get('/:reference', paymentConfirmLimiter, wrap(paymentsController.confirm));

export default router;
