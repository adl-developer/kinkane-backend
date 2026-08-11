import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
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
 * Returns 200: { orders: [{ id, status, currency, subtotalMinor, shippingMinor,
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
router.get('/:id', requireAuth, wrapHttp(ordersController.get));

export default router;
