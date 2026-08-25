import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import { checkoutLimiter } from '../middleware/rate-limit.middleware';
import { wrapHttp } from '../lib/route-helpers';
import { cartController } from '../controllers/cart.controller';

const router = Router();

/**
 * POST /api/v1/cart/price   { lines: [{ bookId, quantity }], currency? }
 *
 * Prices a basket the client is holding. **Stores nothing** — no cart row, no
 * token, no record of a visitor who never signs up. This is what a guest's
 * basket renders from before they have an account.
 *
 * The request carries book ids and quantities only. Every price, sale price and
 * stock figure in the response is read from our own data, so an anonymous
 * caller cannot influence what anything costs.
 *
 * Public — no auth required. Works signed-in too, without touching the stored
 * cart.
 *
 * Returns 200: { currency, lines: [...], subtotalMinor, estimatedShippingMinor,
 *                totalMinor, itemCount, hasIssues }
 * Errors: 400 validation
 */
router.post('/price', optionalAuth, wrapHttp(cartController.price));

// Buying is NOT gated behind Kinkané Plus — every authenticated user can fill a
// cart and check out. Gate the bookshelf, not the till.

/**
 * GET /api/v1/cart?currency=USD
 *
 * The user's cart, priced live. Every read re-checks price and stock against
 * the Gardners feed, so lines carry `priceChanged` / `unavailable` flags and
 * the current `stockQty` for capping a quantity stepper. Creates an empty cart
 * on first call.
 *
 * Currency is resolved from the caller's location, defaulting to USD; the
 * optional `currency` param overrides it and is ignored if unsupported.
 *
 * Returns 200: { cartId, currency, lines: [...], subtotalMinor,
 *                estimatedShippingMinor, totalMinor, itemCount, hasIssues }
 * Errors: 401 unauthenticated
 */
router.get('/', requireAuth, wrapHttp(cartController.get));

/**
 * POST /api/v1/cart/items
 *
 * Adds a book, or increases an existing line. `quantity` is a delta here.
 * Clamped to live stock and CART_MAX_QUANTITY_PER_LINE — the response's
 * `clamped`/`clampedTo` say so when that happens.
 *
 * Body: { bookId, quantity? }
 * Returns 200: the cart line
 * Errors: 400 validation | 401 unauthenticated | 404 book not found |
 *         409 OUT_OF_STOCK | 409 NOT_FOR_SALE | 409 UNAVAILABLE |
 *         409 MARKET_RESTRICTED | 409 CART_FULL
 */
router.post('/items', requireAuth, wrapHttp(cartController.addItem));

/**
 * PATCH /api/v1/cart/items/:bookId
 *
 * Sets a line to an absolute quantity — this is the "increase or reduce"
 * endpoint. `quantity: 0` removes the line.
 *
 * Body: { quantity }
 * Returns 200: the cart line, or { removed: true }
 * Errors: 400 validation | 401 unauthenticated | 404 NOT_IN_CART | 409 stock
 */
router.patch('/items/:bookId', requireAuth, wrapHttp(cartController.setQuantity));

/**
 * DELETE /api/v1/cart/items/:bookId
 * Removes a line. Idempotent.
 * Returns 200: { success: true }
 */
router.delete('/items/:bookId', requireAuth, wrapHttp(cartController.removeItem));

/**
 * DELETE /api/v1/cart
 * Empties the cart, keeping the cart itself.
 * Returns 200: { removed: number }
 */
router.delete('/', requireAuth, wrapHttp(cartController.clear));

/**
 * POST /api/v1/cart/checkout
 *
 * Prices the basket for a destination, creates the order, and returns a Stripe
 * Checkout URL. `shippingCountry` is required and is asked for here rather than
 * left to Stripe because shipping and tax are both calculated from it — Stripe
 * only collects an address after the amount is fixed.
 *
 * A 409 with `code: 'CART_CHANGED'` is an expected outcome, not an error state:
 * it carries `changes` describing what moved, and the cart has already been
 * repaired, so retrying after showing the user succeeds.
 *
 * Body: { shippingCountry, currency? }
 * Returns 200: { url, orderId, sessionId, currency, totalMinor }
 * Errors: 400 CART_EMPTY / INVALID_COUNTRY | 401 unauthenticated |
 *         409 CART_CHANGED | 429 rate limit | 503 payments not configured
 */
// optionalAuth: a signed-in buyer checks out the cart we store; a guest sends
// their basket as `lines`. Either way the server prices every line itself.
router.post('/checkout', optionalAuth, checkoutLimiter, wrapHttp(cartController.checkout));

export default router;
