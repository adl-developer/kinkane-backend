import {
  ref, resp, json, body, object, param, arrayOf, authErrors, successResponse,
  publicEndpoint,
} from '../helpers';

const TAG = 'Shop';
const ORDERS = 'Orders & Payments';

const bookIdParam = param('bookId', 'path', { type: 'integer' }, 'Book id.', { example: 48213 });

/**
 * A basket line as the client sends it. Book id and quantity only — there is
 * deliberately no price field, because the server prices everything itself.
 */
const requestedLine = object({
  bookId: { type: 'integer', example: 48213 },
  quantity: { type: 'integer', minimum: 1, example: 2 },
}, ['bookId', 'quantity']);

const currencyParam = param('currency', 'query', { type: 'string', minLength: 3, maxLength: 3 },
  'ISO-4217 override for the display currency. Resolved from the caller’s country when omitted. **Silently ignored** if unsupported — check `currency` on the response rather than assuming the override took.',
  { example: 'GBP' });

/**
 * Money is in minor units everywhere in this API (cents, pence) as an integer.
 * Documented on every field rather than once, because a client that reads
 * `totalMinor: 3497` as £3,497 is a bug nobody catches in review.
 */
export const commercePaths = {
  '/api/v1/cart/price': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Price a basket the client is holding',
      description: [
        '**Before sign-in, the basket lives on the client and nothing is stored server-side.** This is how it gets rendered: send the lines, get back live prices, stock, sale badges and totals. No cart row is created, no token is issued, and nothing is recorded about a visitor who never signs up.',
        '',
        'Works signed-in too, when you want to price a basket without touching the stored cart.',
        '',
        '### What the server ignores',
        'The request carries **book ids and quantities only**. Any price-like field is ignored — every amount in the response is computed from our own data. This is what makes an unauthenticated pricing endpoint safe, and it is the same rule checkout enforces.',
        '',
        '### Reading the response',
        '`availableQuantity` is capped at what you asked for. When it is lower than `quantity`, that line is short on stock — show "only N available" rather than silently reducing it. Totals are computed on `availableQuantity`, so they never include copies we cannot ship.',
        '',
        'Duplicate `bookId` entries are merged rather than rejected.',
        '',
        'All amounts are **integer minor units** of `currency` — 3497 is £34.97, never £3,497.',
      ].join('\n'),
      requestBody: body(object({
        lines: arrayOf(requestedLine, 'The basket. An empty array returns an empty, zeroed basket rather than an error.'),
        currency: {
          type: 'string', minLength: 3, maxLength: 3,
          description: 'ISO-4217 override. Ignored if unsupported — read `currency` off the response.',
          example: 'GBP',
        },
      }, ['lines'])),
      responses: {
        200: json('The basket, priced.', ref('PricedBasket')),
        400: resp('ValidationError'),
      },
    },
  },

  '/api/v1/cart/shipping-options': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Delivery options for a basket, priced',
      description: [
        'What delivery this basket can have to this country, and what each costs. Prices nothing else and stores nothing.',
        '',
        '### Why this screen matters',
        'The gap between the two overseas services is not cosmetic. The same 400g parcel to Ghana is **£8.45 untracked and £32.52 tracked** — often more than the books. This is where the buyer decides whether to pay for tracking, rather than having it decided for them.',
        '',
        '### Reading the response',
        'Only services the destination actually supports come back, read from our supplier’s published rates. Coverage is genuinely uneven: some countries are tracked-only, some untracked-only, and a few we can address have no published rate at all.',
        '',
        'An **empty `options` array is a real answer, not an error.** `unavailableReason` says which: `country_not_supported` (we cannot address a parcel there) or `no_service` (we can, but nothing can carry this basket — usually a basket too heavy for the only service available). Show it in the cart rather than letting the buyer reach checkout and be refused.',
        '',
        '`recommended` marks the option to preselect — the **cheapest**, not the fastest, and the same figure the cart shows as its estimate.',
        '',
        '`weightEstimated` is true when a book in the basket had no weight recorded and one was assumed. The price is still binding; the flag is for support, not the buyer.',
        '',
        'Pass the chosen `serviceCode` to `POST /cart/checkout`. Prices are re-derived there from the code alone — a price sent by a client is never trusted.',
      ].join('\n'),
      requestBody: body(object({
        countryCode: {
          type: 'string', minLength: 2, maxLength: 2,
          description: 'ISO-3166 alpha-2 destination. Required — this is not guessed from the caller’s IP, because quoting one country and charging for another is the failure this endpoint exists to prevent.',
          example: 'GH',
        },
        lines: arrayOf(requestedLine, 'The basket. Signed-in callers may omit this to price their stored cart.'),
        currency: {
          type: 'string', minLength: 3, maxLength: 3,
          description: 'ISO-4217 override. Ignored if unsupported — read `currency` off the response.',
          example: 'GBP',
        },
      }, ['countryCode'])),
      responses: {
        200: json('The delivery options available.', object({
          currency: { type: 'string', example: 'GBP' },
          options: arrayOf(object({
            serviceCode: { type: 'string', example: '010', description: 'Pass this to checkout.' },
            label: { type: 'string', example: 'Standard international' },
            tracked: { type: 'boolean', example: false },
            estimatedDaysMin: { type: 'integer', example: 7 },
            estimatedDaysMax: { type: 'integer', example: 10 },
            priceMinor: { type: 'integer', example: 915, description: 'Minor units of `currency`.' },
            priceGbpPence: { type: 'integer', example: 915 },
            recommended: { type: 'boolean', example: true },
          }), 'Cheapest first.'),
          weightEstimated: { type: 'boolean', example: false },
          unavailableReason: {
            type: 'string', nullable: true, enum: ['country_not_supported', 'no_service'],
            example: null,
          },
        })),
        400: resp('ValidationError'),
      },
    },
  },

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
        '### Signed in or not',
        'A **signed-in** buyer checks out the cart we store — send no `lines`. A **guest** sends their basket as `lines` and a `contactEmail`; omitting `lines` without a session returns `LINES_REQUIRED`. Either way the server prices every line itself and ignores anything price-shaped in the body.',
        '',
        '### Address',
        'Send a full `shippingAddress` — its `countryCode` is the destination the order is priced against, and Stripe then collects nothing but payment. Shipping and tax both depend on that country, which is why it has to be settled before the Stripe session exists.',
        '',
        'Passing only `shippingCountry` still works: Stripe collects the address instead, locked to that country. Send one or the other.',
        '',
        '### Keep the access token',
        '`accessToken` comes back **exactly once** and is the only credential that can reach this order without an account — it is what `POST /orders/lookup` and `POST /orders/claim` take. Only its hash is stored, so it cannot be re-sent. **Persist it as soon as you receive it**, and put a tracking link in the confirmation email; a guest who loses it has no route back to their order.',
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
        shippingAddress: object({
          name: { type: 'string', maxLength: 200, example: 'Rachel TM' },
          line1: { type: 'string', maxLength: 200, example: '19 H P Nyemitei St' },
          line2: { type: 'string', maxLength: 200, nullable: true, example: null },
          city: { type: 'string', maxLength: 200, example: 'Accra' },
          region: { type: 'string', maxLength: 200, nullable: true, example: null },
          postcode: { type: 'string', maxLength: 32, example: 'GZ-188-608' },
          countryCode: {
            type: 'string', minLength: 2, maxLength: 2,
            description: 'ISO-3166 alpha-2. **This is the destination the order is priced against.**',
            example: 'GH',
          },
        }, ['name', 'line1', 'city', 'postcode', 'countryCode']),
        shippingServiceCode: {
          type: 'string', pattern: '^\\d{3}$',
          description: 'The delivery service the buyer chose, from `POST /cart/shipping-options`. Optional: omitting it gets the **cheapest** available service, so a client that never showed a chooser does not silently upgrade the buyer onto the expensive one. A code that does not serve the destination is a `400 SHIPPING_SERVICE_UNAVAILABLE` rather than a quiet downgrade.',
          example: '010',
        },
        shippingCountry: {
          type: 'string', minLength: 2, maxLength: 2,
          description: 'Only when you are *not* sending `shippingAddress`. One of the two is required.',
          example: 'US',
        },
        lines: arrayOf(requestedLine, 'Guests only — the client-held basket. Ignored when signed in, because the stored cart is authoritative.'),
        contactEmail: {
          type: 'string', format: 'email', maxLength: 254,
          description: 'Guests only, and required for them — there is no account to read an email from. Ignored when signed in; the account email always wins.',
          example: 'rachel@example.com',
        },
        contactPhone: {
          type: 'string', maxLength: 32,
          description: 'Optional delivery contact, international format (`+233…` or `00233…`; spaces, dashes and brackets are stripped). Unlike `contactEmail` this is honoured when signed in, so a buyer can give the recipient\'s number. Omitted by a signed-in buyer, the number on their profile is used. Passed to the courier as the SMS tracking contact.',
          example: '+233201234567',
        },
        currency: {
          type: 'string', minLength: 3, maxLength: 3,
          description: 'ISO-4217 override. Falls back to the resolved currency; ignored if unsupported.',
          example: 'USD',
        },
      })),
      responses: {
        200: json('Order created; send the user to `url`.',
          object({
            url: { type: 'string', format: 'uri', description: 'Stripe Checkout URL.', example: 'https://checkout.stripe.com/c/pay/cs_test_a1B2…' },
            orderId: { type: 'integer', example: 1042 },
            sessionId: { type: 'string', example: 'cs_test_a1B2c3D4…' },
            currency: { type: 'string', example: 'USD' },
            totalMinor: { type: 'integer', description: 'Total in minor units, discount already applied.', example: 3497 },
            discountMinor: {
              type: 'integer',
              description: 'What the first-order promotion took off, 0 when it did not apply. This is the first point in the flow where it can be known — eligibility depends on the buyer\'s email, and the basket endpoints deliberately never ask for one, so the cart cannot show it.',
              example: 1117,
            },
            discountReason: {
              type: 'string', nullable: true,
              description: '`first_order`, or null when there was no discount.',
              example: 'first_order',
            },
            reference: {
              type: 'string',
              description: 'Customer-facing order identity. Safe to display and to print in emails.',
              example: 'ORD-7K2M9QX4',
            },
            accessToken: {
              type: 'string',
              description:
                'Returned **once**. The credential for `POST /orders/lookup` and `POST /orders/claim`. Store it immediately; it cannot be re-issued. Never put it in a URL you log, and never display it.',
              example: 'v4Xk9…',
            },
          })),
        400: json('`CART_EMPTY`; `LINES_REQUIRED` for a guest who sent no basket; `EMAIL_REQUIRED` for a guest with no `contactEmail`; `CART_TOO_LARGE`; or `INVALID_COUNTRY`.', ref('Error'),
          { error: 'Send your basket as `lines` to check out without an account', code: 'LINES_REQUIRED' }),
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

  '/api/v1/saved-books': {
    get: {
      tags: [TAG],
      summary: 'The purchase wishlist',
      description: [
        '"Saved Books" — titles the customer marked to buy later. **Not the same as the reading list** in `/user-books`, which is about books they read; this is about books they intend to buy.',
        '',
        'Newest first, and **priced live through the same gate that charges at checkout**, so a saved book shows the price it will actually cost rather than the price it cost when saved.',
        '',
        'A title that has since become unbuyable is **kept and flagged** (`unavailable` with a reason), never dropped — someone who saved a book deserves to be told it is gone rather than watching it silently vanish.',
        '',
        'Requires a signed-in user but **not a subscription**. Nothing is stored for a guest: keep saved books on the device and replay them here after sign-in, exactly as with the basket.',
      ].join('\n'),
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page.'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
        currencyParam,
      ],
      responses: {
        200: json('The wishlist.', object({
          books: arrayOf(object({
            bookId: { type: 'integer', example: 48213 },
            isbn13: { type: 'string', nullable: true, example: '9780241988268' },
            title: { type: 'string', example: 'Girl, Woman, Other' },
            contributor: { type: 'string', nullable: true, example: 'Bernardine Evaristo' },
            coverUrl: { type: 'string', format: 'uri', nullable: true },
            savedAt: { type: 'string', format: 'date-time', example: '2026-08-01T12:00:00.000Z' },
            unitPriceMinor: {
              type: 'integer', nullable: true,
              description: 'Null when the book can no longer be bought.',
              example: 1299,
            },
            compareAtMinor: {
              type: 'integer', nullable: true,
              description: 'Marked down from this. Null means not on sale.',
              example: null,
            },
            inStock: { type: 'boolean', example: true },
            unavailable: { type: 'boolean', example: false },
            unavailableReason: { type: 'string', nullable: true, example: null },
          })),
          total: { type: 'integer', example: 3 },
          hasMore: { type: 'boolean', example: false },
        })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },

    post: {
      tags: [TAG],
      summary: 'Save a book',
      description: 'Idempotent — saving the same book twice is the same as saving it once, so a double tap on the heart cannot error.',
      requestBody: body(object({ bookId: { type: 'integer', example: 48213 } }, ['bookId'])),
      responses: {
        200: json('Saved.', object({ saved: { type: 'boolean', example: true } })),
        400: resp('ValidationError'),
        404: json('No such book, or it has been withdrawn.', ref('Error'), { error: 'Book not found' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/saved-books/{bookId}': {
    delete: {
      tags: [TAG],
      summary: 'Remove a saved book',
      description: 'Also idempotent: removing something that was not saved is a success, and `removed` reports which it was.',
      parameters: [bookIdParam],
      responses: {
        200: json('Removed, or was not there.',
          object({ removed: { type: 'boolean', example: true } })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/orders/lookup': {
    post: {
      tags: [ORDERS],
      ...publicEndpoint,
      summary: 'Track an order without an account',
      description: [
        'The "Track My Order" call for a guest. Takes the `reference` and `accessToken` returned by checkout.',
        '',
        '**Both are required, and they are not interchangeable.** The reference is an identifier — it is printed on receipts and quoted in support, so it is not treated as secret. The token is the credential.',
        '',
        'An unknown reference, a wrong token and a mistyped one all return the same `404` with the same body, so this cannot be used to discover which orders exist. Do not try to distinguish them in your error handling; show one "we couldn\u2019t find that order" state.',
        '',
        '**Rate limit:** 10 per 15 minutes per IP. A user retyping a reference will not hit it; a script will.',
      ].join('\n'),
      requestBody: body(object({
        reference: { type: 'string', example: 'ORD-7K2M9QX4' },
        token: {
          type: 'string',
          description: 'The `accessToken` from the checkout response.',
          example: 'v4Xk9…',
        },
      }, ['reference', 'token'])),
      responses: {
        200: json('The order, with its lines.', ref('Order')),
        400: resp('ValidationError'),
        404: json('No such order, or the token does not match. Deliberately indistinguishable.', ref('Error'),
          { error: 'Order not found' }),
        429: resp('RateLimited'),
      },
    },
  },

  '/api/v1/orders/claim': {
    post: {
      tags: [ORDERS],
      summary: 'Attach a guest order to the signed-in account',
      description: [
        'The "Save your order details" step after checkout: the buyer creates an account, then claims the order they just placed so it appears in their history.',
        '',
        'Requires authentication — the account comes from the bearer token, never from the body. Sign the user up or in first, then call this with the reference and token from checkout.',
        '',
        '### Single use',
        'The access token is retired on success. A confirmation email forwarded to someone else cannot re-home an order that already has an owner, and a second claim of the same order returns `404`.',
        '',
        '`404` covers unknown reference, wrong token and already-claimed alike.',
        '',
        '**Rate limit:** 10 per 15 minutes per IP.',
      ].join('\n'),
      requestBody: body(object({
        reference: { type: 'string', example: 'ORD-7K2M9QX4' },
        token: { type: 'string', description: 'The `accessToken` from the checkout response.', example: 'v4Xk9…' },
      }, ['reference', 'token'])),
      responses: {
        200: json('Claimed. It will now appear in `GET /orders`.', ref('Order')),
        400: resp('ValidationError'),
        404: json('Unknown, wrong token, or already claimed.', ref('Error'), { error: 'Order not found' }),
        // authErrors already carries the 429.
        ...authErrors,
      },
    },
  },

  '/api/v1/orders': {
    get: {
      tags: [ORDERS],
      summary: 'List orders',
      description:
        'The caller’s order history, newest first.\n\n**Excludes checkouts that were never paid for.** An abandoned Stripe session is not something a customer thinks of as an order, and listing it reads as a billing error.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
        param('status', 'query', { type: 'string', enum: ['in_progress', 'delivered', 'closed'] },
          'Filters to the order-history tabs. Omit for All. This can only ever narrow the list — an abandoned checkout is never returned, whatever you pass.',
          { example: 'in_progress' }),
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
