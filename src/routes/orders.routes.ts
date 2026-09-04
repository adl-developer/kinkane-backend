import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { guestOrderLimiter } from '../middleware/rate-limit.middleware';
import { wrapHttp } from '../lib/route-helpers';
import { ordersController } from '../controllers/orders.controller';

const router = Router();

/**
 * GET /api/v1/orders?limit=20&offset=0
 *
 * The user's order history, newest first. Excludes checkouts that were never
 * completed — an abandoned Stripe session is not something a customer thinks of
 * as an order, and listing it reads as a billing error.
 *
 * `status=in_progress|delivered|closed` filters to the order UI's tabs. It can
 * only ever narrow the listable set — an incomplete checkout is never an order.
 *
 * Returns 200: { orders: [{ id, reference, status, statusBucket, currency, subtotalMinor, shippingMinor,
 *                           taxMinor, totalMinor, itemCount, placedAt, paidAt,
 *                           shippingCountryCode, items: [...] }] }
 * Errors: 400 validation | 401 unauthenticated
 */
router.get('/', requireAuth, wrapHttp(ordersController.list));

/**
 * GET /api/v1/orders/:id
 *
 * One order with its lines. Scoped to the owner; someone else's order is a 404.
 *
 * Returns 200: the order with `items`
 * Errors: 400 invalid id | 401 unauthenticated | 404 not found
 */
/**
 * POST /api/v1/orders/lookup   { reference, token }
 *
 * "Track My Order" for a guest. **Unauthenticated by design** — the token
 * issued at checkout is the credential, and it is the only way to reach an
 * order without an account.
 *
 * Declared before `/:id` would matter if that route were also a POST; it is
 * not, but keeping the specific paths above the parameterised one is the habit
 * that stops a future GET /orders/lookup being swallowed by GET /orders/:id.
 *
 * Returns 200: the order with `items`
 * Errors: 400 malformed reference or token | 404 unknown or wrong token | 429
 */
router.post('/lookup', guestOrderLimiter, wrapHttp(ordersController.lookup));

/**
 * POST /api/v1/orders/track   { code, email }
 *
 * "Track My Order" by the short code printed on the confirmation, plus the
 * email the order was placed with. Unauthenticated and open to signed-in
 * customers alike — see the controller for why it is not scoped to the caller.
 *
 * The 8-character code is an identifier, not a credential; the email is the
 * second factor, and `guestOrderLimiter` is what stops the pair being ground
 * through offline.
 *
 * Returns 200: the order with `items`
 * Errors: 400 malformed code or email | 404 unknown code or wrong email | 429
 */
router.post('/track', guestOrderLimiter, wrapHttp(ordersController.track));

/**
 * POST /api/v1/orders/claim   { reference, token }
 *
 * Attaches a guest order to the signed-in account. Single-use: the token is
 * retired on success, so a forwarded confirmation email cannot re-home an order
 * that already belongs to someone.
 *
 * Returns 200: the claimed order
 * Errors: 400 malformed | 401 unauthenticated | 404 unknown, wrong token, or
 *         already claimed | 429
 */
router.post('/claim', guestOrderLimiter, requireAuth, wrapHttp(ordersController.claim));

router.get('/:id', requireAuth, wrapHttp(ordersController.get));

export default router;
