import {
  ref, resp, json, body, object, param, arrayOf, authErrors, successResponse,
} from '../helpers';

const TAG = 'Shop';
const ORDERS = 'Orders & Payments';

const bookIdParam = param('bookId', 'path', { type: 'integer' }, 'Book id.', { example: 48213 });

const currencyParam = param('currency', 'query', { type: 'string', minLength: 3, maxLength: 3 },
  'ISO-4217 override for the display currency. Resolved from the caller’s country when omitted. **Silently ignored** if unsupported — check `currency` on the response rather than assuming the override took.',
  { example: 'GBP' });

/**
 * Money is in minor units everywhere in this API (cents, pence) as an integer.
 * Documented on every field rather than once, because a client that reads
 * `totalMinor: 3497` as £3,497 is a bug nobody catches in review.
 */
export const commercePaths = {
  '/api/v1/cart': {
    get: {
      tags: [TAG],
      summary: 'Get the cart',
      description: [
        'The caller’s cart, **re-priced live on every read** against the wholesaler feed. Creates an empty cart on first call, so this never 404s.',
        '',
        'Because pricing is live, lines carry `priceChanged` and `unavailable` flags and a current `stockQty`. Surface them: `hasIssues` being true and the user checking out anyway is exactly what produces a `CART_CHANGED` 409.',
        '',
        'All amounts are **integer minor units** of `currency` — 3497 is $34.97, never $3,497.',
      ].join('\n'),
      parameters: [currencyParam],
      responses: {
        200: json('The cart.', ref('Cart')),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },

    delete: {
      tags: [TAG],
      summary: 'Empty the cart',
      description: 'Removes every line but keeps the cart itself, so the next `GET` still succeeds.',
      responses: {
        200: json('Emptied.',
          object({ removed: { type: 'integer', description: 'Lines removed.', example: 3 } }),
          { removed: 3 }),
        ...authErrors,
      },
    },
  },

  '/api/v1/cart/items': {
    post: {
      tags: [TAG],
      summary: 'Add a book to the cart',
      description: [
        '`quantity` here is a **delta** — adding a book already in the cart increases the line rather than replacing it. To set an absolute quantity, use `PATCH /cart/items/{bookId}`.',
        '',
        'The quantity is clamped to live stock and to the per-line cap. When that happens the response comes back with `clamped: true` and `clampedTo` set — a **200, not an error** — so show the user the adjusted number rather than treating it as a failure.',
        '',
        'Buying is open to every signed-in user; there is no Plus gate anywhere in the shop.',
      ].join('\n'),
      requestBody: body(object({
        bookId: { type: 'integer', minimum: 1, example: 48213 },
        quantity: {
          type: 'integer', minimum: 1, default: 1,
          description: 'How many to add. Capped by `CART_MAX_QUANTITY_PER_LINE` (10 by default).',
          example: 1,
        },
      }, ['bookId'])),
      responses: {
        200: json('The resulting cart line.', ref('CartLine')),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        409: json(
          'The book cannot be added. Branch on `code`: `OUT_OF_STOCK`, `NOT_FOR_SALE`, `UNAVAILABLE`, `MARKET_RESTRICTED` (not licensed for sale in the caller’s country), or `CART_FULL` (the cart is at `CART_MAX_ITEMS`, 20 by default).',
          ref('Error'),
          { error: 'This title is out of stock', code: 'OUT_OF_STOCK' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/cart/items/{bookId}': {
    patch: {
      tags: [TAG],
      summary: 'Set a line’s quantity',
      description:
        'Absolute, unlike `POST /cart/items` — this is the endpoint behind a quantity stepper.\n\n**`quantity: 0` removes the line** and returns `{ removed: true }`, so a stepper clicked down to nothing behaves as the user expects without a second call.',
      parameters: [bookIdParam],
      requestBody: body(object({
        quantity: {
          type: 'integer', minimum: 0,
          description: 'The new absolute quantity. `0` removes the line. Capped by `CART_MAX_QUANTITY_PER_LINE`.',
          example: 2,
        },
      }, ['quantity'])),
      responses: {
        200: {
          description: 'The updated line, or a removal confirmation when `quantity` was 0.',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  ref('CartLine'),
                  object({ removed: { type: 'boolean', example: true } }),
                ],
              },
            },
          },
        },
        400: resp('ValidationError'),
        404: json('That book is not in the cart.', ref('Error'),
          { error: 'Not in cart', code: 'NOT_IN_CART' }),
        409: json('Not enough stock for the requested quantity.', ref('Error'),
          { error: 'Only 3 in stock', code: 'OUT_OF_STOCK' }),
        ...authErrors,
      },
    },

    delete: {
      tags: [TAG],
      summary: 'Remove a line',
      description: 'Idempotent — removing a book that is not in the cart still returns 200.',
      parameters: [bookIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/cart/checkout': {
    post: {
      tags: [TAG],
      summary: 'Check out',
      description: [
        'Prices the basket for a destination, creates the order, and returns a Stripe Checkout URL for the client to open.',
        '',
        '**`shippingCountry` is required here, before Stripe.** Shipping and tax are both calculated from it, and Stripe only collects an address *after* the amount is fixed — so it has to be asked for on our side.',
        '',
        '### The 409 you should expect',
        'A `409` with `code: CART_CHANGED` is a **normal outcome, not an error state**. Prices and stock are re-checked at this moment; when something moved, the response carries `changes` describing what, and **the cart has already been repaired**. Show the user what changed and retry — the retry succeeds.',
        '',
        '### After the redirect',
        'Send the user to `url`. When they come back, confirm with `GET /payments/{reference}` rather than trusting the return URL — the webhook may not have landed yet, and that endpoint falls back to asking Stripe directly.',
        '',
        '**Rate limit:** 20 per hour.',
      ].join('\n'),
      requestBody: body(object({
        shippingCountry: {
          type: 'string', minLength: 2, maxLength: 2,
          description: 'ISO-3166 alpha-2 destination country. Required — shipping and tax both depend on it.',
          example: 'US',
        },
        currency: {
          type: 'string', minLength: 3, maxLength: 3,
          description: 'ISO-4217 override. Falls back to the resolved currency; ignored if unsupported.',
          example: 'USD',
        },
      }, ['shippingCountry'])),
      responses: {
        200: json('Order created; send the user to `url`.',
          object({
            url: { type: 'string', format: 'uri', description: 'Stripe Checkout URL.', example: 'https://checkout.stripe.com/c/pay/cs_test_a1B2…' },
            orderId: { type: 'integer', example: 1042 },
            sessionId: { type: 'string', example: 'cs_test_a1B2c3D4…' },
            currency: { type: 'string', example: 'USD' },
            totalMinor: { type: 'integer', description: 'Total in minor units.', example: 3497 },
          })),
        400: json('`CART_EMPTY`, or `INVALID_COUNTRY` for an unrecognised destination.', ref('Error'),
          { error: 'Your cart is empty', code: 'CART_EMPTY' }),
        409: json(
          'Prices or stock moved. **Expected** — the cart has already been repaired, so show `changes` and retry.',
          object({
            error: { type: 'string', example: 'Your cart changed before checkout' },
            code: { type: 'string', enum: ['CART_CHANGED'], example: 'CART_CHANGED' },
            changes: arrayOf(object({
              bookId: { type: 'integer', example: 48213 },
              title: { type: 'string', example: 'Girl, Woman, Other' },
              change: {
                type: 'string',
                enum: ['price_increased', 'price_decreased', 'quantity_reduced', 'removed'],
                example: 'price_increased',
              },
              from: { type: 'integer', nullable: true, description: 'Previous value (minor units, or quantity).', example: 1299 },
              to: { type: 'integer', nullable: true, description: 'New value.', example: 1399 },
            })),
          })),
        503: resp('PaymentsUnavailable'),
        ...authErrors,
      },
    },
  },

  // ── Orders ─────────────────────────────────────────────────────────────────

  '/api/v1/orders': {
    get: {
      tags: [ORDERS],
      summary: 'List orders',
      description:
        'The caller’s order history, newest first.\n\n**Excludes checkouts that were never paid for.** An abandoned Stripe session is not something a customer thinks of as an order, and listing it reads as a billing error.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of orders.', object({ orders: arrayOf(ref('Order')) })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/orders/{id}': {
    get: {
      tags: [ORDERS],
      summary: 'Get one order',
      description:
        'One order with its lines. Scoped to the owner — someone else’s order id returns **404, not 403**, so this cannot be used to discover which order ids exist.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Order id.', { example: 1042 })],
      responses: {
        200: json('The order.', ref('Order')),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/payments/{reference}': {
    get: {
      tags: [ORDERS],
      summary: 'Confirm a payment',
      description: [
        'Confirms a payment the client started earlier, whether it was a subscription or a book order — **one reference format for both**, so the app stores a single string and never branches on payment type.',
        '',
        'Reads our own record first and, while the payment is still pending, **falls back to asking Stripe directly**. That is deliberate: the user returns from the Stripe page before the webhook arrives, so a naive implementation would answer "pending" and make the client poll through it. Here the first call usually gets a definitive answer.',
        '',
        '**Branch on `paid` (a boolean); `status` carries the detail.**',
        '',
        '**Rate limit:** 60 per minute — generous enough to poll, if you still need to.',
      ].join('\n'),
      parameters: [
        param('reference', 'path', { type: 'string' },
          'The reference returned alongside the Stripe URL when the checkout session was created. Case-insensitive.',
          { example: 'KP-7K3M9QXV2TB4' }),
      ],
      responses: {
        200: json('The payment’s current state.',
          object({
            reference: { type: 'string', example: 'KP-7K3M9QXV2TB4' },
            kind: { type: 'string', enum: ['subscription', 'order'], example: 'order' },
            status: {
              type: 'string',
              enum: ['pending', 'succeeded', 'failed', 'expired', 'cancelled'],
              example: 'succeeded',
            },
            paid: { type: 'boolean', description: 'The field to branch on.', example: true },
            amountCents: { type: 'integer', description: 'Minor units.', example: 3497 },
            currency: { type: 'string', example: 'USD' },
            orderId: { type: 'integer', nullable: true, description: 'Set when `kind` is `order`.', example: 1042 },
            paidAt: { type: 'string', format: 'date-time', nullable: true, example: '2026-08-01T12:01:14.000Z' },
            reason: {
              type: 'string', nullable: true,
              description: 'Why it failed, when it did.',
              example: null,
            },
          })),
        400: json('Malformed reference.', ref('Error'), { error: 'Invalid payment reference' }),
        404: json('Unknown reference, or it belongs to another user — indistinguishable by design.',
          ref('Error'), { error: 'Not found' }),
        ...authErrors,
      },
    },
  },
};
