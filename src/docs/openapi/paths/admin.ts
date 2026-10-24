import { ref, resp, json, body, object, param, arrayOf, publicEndpoint } from '../helpers';

const TAG = 'Admin Console';

/** Session, error and paging responses every console endpoint shares. */
const adminErrors = {
  401: json('No session, an expired one, or a token that is not an admin token.',
    object({ error: { type: 'string', example: 'Unauthorized' } })),
  503: json('`ADMIN_JWT_SECRET` is not configured, so the console cannot issue or verify sessions. Deliberately a hard failure rather than falling back to the customer JWT secret.',
    object({ error: { type: 'string', example: 'Admin console is not configured' } })),
  500: resp('ServerError'),
};

const pagingParams = [
  param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'Rows per page.'),
  param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Rows to skip.'),
];

const orderTabs = ['all', 'processing', 'shipped', 'delivered', 'needs_attention', 'unpaid'];

export const adminPaths = {
  '/admin/console/auth/login': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Sign in to the admin console',
      description: [
        'Exchanges an admin email and password for a console session token. Send it as `Authorization: Bearer <token>` on every other endpoint here.',
        '',
        '**Admins are a separate population from customers.** They live in their own table, sign sessions with their own secret (`ADMIN_JWT_SECRET`), and no customer token will ever verify here — so no path through the app’s auth stack can end with a customer holding admin rights.',
        '',
        'There is no self-service signup. Accounts are created with `npm run admin:create`. A forgotten password is reset by email — see `POST /admin/console/auth/forgot-password`.',
        '',
        'Sessions last `ADMIN_TOKEN_TTL` seconds (12h by default) and there is no refresh token — signing in again is cheap, and a long-lived refresh credential for an account that can export the customer list is not worth the risk.',
      ].join('\n'),
      requestBody: body(object({
        email: { type: 'string', format: 'email', example: 'admin@kinkane.app' },
        password: { type: 'string', example: '••••••••••••' },
      }, ['email', 'password'])),
      responses: {
        200: json('Signed in.', object({
          token: { type: 'string', description: 'Bearer token for the console.', example: 'eyJhbGciOiJIUzI1NiIs…' },
          expiresIn: { type: 'integer', description: 'Seconds until the token expires.', example: 43200 },
          admin: object({
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Ama Boateng' },
            email: { type: 'string', format: 'email', example: 'admin@kinkane.app' },
          }),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        401: json('Wrong email or password. Deliberately one message for both, so the form cannot be used to discover which staff addresses exist.',
          object({ error: { type: 'string', example: 'Invalid email or password' }, code: { type: 'string', example: 'INVALID_CREDENTIALS' } })),
        429: resp('RateLimited'),
        503: adminErrors[503],
        500: resp('ServerError'),
      },
    },
  },

  '/admin/console/auth/me': {
    get: {
      tags: [TAG],
      summary: 'The signed-in admin',
      description: 'Who the current session belongs to. The account is re-read from the database on every admin request, so disabling an admin takes effect on their next call rather than when their token happens to expire.',
      responses: {
        200: json('The admin.', object({
          admin: object({
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Ama Boateng' },
            email: { type: 'string', format: 'email', example: 'admin@kinkane.app' },
            lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          }),
        })),
        ...adminErrors,
      },
    },
  },

  '/admin/console/auth/change-password': {
    post: {
      tags: [TAG],
      summary: 'Change your own admin password',
      description: [
        'Requires the current password as well as the new one. Not ceremony: a console session lasts 12 hours, so an unattended laptop is a plausible way in, and without the check that is enough to lock the real owner out of an account that can suspend customers.',
        '',
        'The new password must be at least 12 characters and must differ from the current one — a no-op change means somebody believes they have rotated a credential when they have not.',
        '',
        '**Every existing session for this admin is signed out, including the one making the call.** The response carries a fresh session (`token`, `expiresIn`, `admin` — the same shape as login); the console must swap it in, or its next request gets a 401.',
        '',
        'This is also the endpoint to use straight after a first sign-in with `ADMIN_BOOTSTRAP_PASSWORD`.',
      ].join('\n'),
      requestBody: body(object({
        currentPassword: { type: 'string', example: '••••••••••••' },
        newPassword: { type: 'string', minLength: 12, example: '••••••••••••••••' },
      }, ['currentPassword', 'newPassword'])),
      responses: {
        200: json('Changed. Carries the replacement session.', object({
          changed: { type: 'boolean', example: true },
          token: { type: 'string', description: 'The new bearer token. Every earlier one is now refused.', example: 'eyJhbGciOiJIUzI1NiIs…' },
          expiresIn: { type: 'integer', example: 43200 },
          admin: object({
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Ama Boateng' },
            email: { type: 'string', format: 'email', example: 'admin@kinkane.app' },
          }),
        })),
        400: json('Too short, or identical to the current password.', ref('ValidationError')),
        429: resp('RateLimited'),
        // Spread first so the more specific 401 below wins — adminErrors carries
        // a generic one.
        ...adminErrors,
        401: json('The current password is wrong, or the session is invalid.',
          object({ error: { type: 'string' }, code: { type: 'string', example: 'INVALID_CREDENTIALS' } })),
      },
    },
  },

  '/admin/console/auth/forgot-password': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Email an admin a password reset link',
      description: [
        'Sends a single-use reset link to the address, if it belongs to an active admin. The link opens `ADMIN_CONSOLE_URL/reset-password?token=…` (default `APP_URL/admin/reset-password?token=…`); the console page reads `token` and posts it to `reset-password`.',
        '',
        '**The response is the same whether or not the address is an admin’s**, so this cannot be used to find out which staff addresses exist. Disabled admins are never sent a link.',
        '',
        'The response is sent before any work is done, so its timing is the same for every address too.',
        '',
        'The link expires after 30 minutes. Asking again replaces the previous link. Rate limited per IP (in a bucket separate from login) and to 3 requests an hour per target address, so nobody can flood an admin’s inbox or keep invalidating their link.',
      ].join('\n'),
      requestBody: body(object({
        email: { type: 'string', format: 'email', example: 'admin@kinkane.app' },
      }, ['email'])),
      responses: {
        200: json('Accepted. Says nothing about whether an email was sent.', object({ sent: { type: 'boolean', example: true } })),
        400: json('Validation failed.', ref('ValidationError')),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/admin/console/auth/reset-password': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Set a new admin password from a reset link',
      description: [
        'Redeems the `token` from a reset email and sets the new password. The token works once.',
        '',
        'The new password must be at least 12 characters. This does not sign the admin in — send them to the login screen afterwards.',
        '',
        '**Every existing console session for the admin is signed out.** If the reason for the reset is that somebody else has a session, this is what removes them.',
      ].join('\n'),
      requestBody: body(object({
        token: { type: 'string', example: '3f9c…' },
        newPassword: { type: 'string', minLength: 12, example: '••••••••••••••••' },
      }, ['token', 'newPassword'])),
      responses: {
        200: json('Password changed.', object({ reset: { type: 'boolean', example: true } })),
        400: json('Validation failed, or the link is invalid, expired, already used, or belongs to a disabled admin (`INVALID_RESET_TOKEN`).',
          object({ error: { type: 'string', example: 'Invalid or expired password reset link' }, code: { type: 'string', example: 'INVALID_RESET_TOKEN' } })),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/admin/console/dashboard': {
    get: {
      tags: [TAG],
      summary: 'Overview cards and recent orders',
      description: [
        'Everything the Dashboard screen needs in one call.',
        '',
        '**`revenueMinor` sums presentment minor units across whatever currencies were charged**, and is labelled with `revenueCurrency`. That is correct only while the shop sells in a single currency; the moment it genuinely sells in several, this needs converting to a base currency. The label exists so the ambiguity is visible rather than silent.',
        '',
        '**Everything here counts paid orders only — the cards and the Recent Orders table alike.** An abandoned Stripe redirect is not a sale, and a total that excluded them above a table that included them would be a dashboard arguing with itself. Abandoned checkouts are still reachable on the Orders screen, under its `unpaid` tab.',
        '',
        '`activeCustomers` means *placed a paid order in the last 12 months*. A customer who has never ordered counts as inactive, not new.',
      ].join('\n'),
      responses: {
        200: json('The dashboard.', object({
          totals: object({
            orders: { type: 'integer', description: 'Paid orders, all time.', example: 2 },
            revenueMinor: { type: 'integer', description: 'Sum of paid order totals, minor units.', example: 9896 },
            revenueCurrency: { type: 'string', example: 'GBP' },
            processing: { type: 'integer', description: 'Paid but not yet dispatched — the fulfilment queue.', example: 1 },
            needsAttention: { type: 'integer', description: 'Paid orders that went wrong: supplier-rejected, refunded or cancelled.', example: 0 },
            unpaid: { type: 'integer', description: 'Checkouts nobody ever paid for. Not a card in the designs — the Orders tab badge reads this.', example: 1 },
            customers: { type: 'integer', example: 12 },
            activeCustomers: { type: 'integer', example: 10 },
            inactiveCustomers: { type: 'integer', example: 2 },
          }),
          recentOrders: arrayOf(object({
            id: { type: 'integer', example: 1042 },
            reference: { type: 'string', example: 'ORD-7K2M9QX4' },
            customerName: { type: 'string', nullable: true, example: 'Jane Doe' },
            contactEmail: { type: 'string', format: 'email' },
            status: { type: 'string', example: 'paid' },
            statusTab: { type: 'string', enum: orderTabs.filter((t) => t !== 'all'), example: 'processing' },
            currency: { type: 'string', example: 'GBP' },
            totalMinor: { type: 'integer', example: 6997 },
            itemCount: { type: 'integer', example: 2 },
            placedAt: { type: 'string', format: 'date-time' },
          })),
        })),
        ...adminErrors,
      },
    },
  },

  '/admin/console/badges': {
    get: {
      tags: [TAG],
      summary: 'Sidebar badge counts',
      description: 'The numbers the console chrome shows: orders awaiting fulfilment, reports awaiting a decision, pending restock requests, and unread notifications. One call rather than one per badge.',
      responses: {
        200: json('The counts.', object({
          orders: { type: 'integer', example: 1 },
          reports: { type: 'integer', example: 3 },
          unreadNotifications: { type: 'integer', example: 3 },
          restockRequests: { type: 'integer', example: 5, description: 'Pending restock requests.' },
        })),
        ...adminErrors,
      },
    },
  },

  '/admin/console/orders': {
    get: {
      tags: [TAG],
      summary: 'Orders, filtered by tab',
      description: [
        '**Read-only.** The Orders screen has no action controls, so there is no endpoint here to change a status, refund, or resend anything. Adding one later should be a deliberate decision rather than an accident of scaffolding.',
        '',
        'The `counts` object comes back on every request with a number for *every* tab, not just the selected one, because the design puts a badge on each.',
        '',
'**Two tabs beyond the designs, split on whether money moved.** The designed three cover only five of the eleven statuses; the rest divide by a line that matters more than any label:',
        '',
        '| Tab | Statuses | Meaning |',
        '| --- | --- | --- |',
        '| `needs_attention` | `supplier_rejected`, `refunded`, `cancelled` | **Money moved and something is wrong.** `supplier_rejected` is the urgent one: the customer paid and the supplier will not fulfil, so we owe them a book or a refund. `fulfilmentError` carries the reason. |',
        '| `unpaid` | `pending_payment`, `payment_failed`, `expired` | **Nobody was ever charged.** An open checkout, a declined card, a timed-out session. No sale, nothing owed. |',
        '',
        'These were one bucket at first, which made the badge meaningless — "3 need attention" could have been three declined cards (nothing owed) or three paid orders stuck at the supplier (three people waiting for a book they paid for). Same number, opposite urgency.',
      ].join('\n'),
      parameters: [
        param('tab', 'query', { type: 'string', enum: orderTabs, default: 'all' }, 'Which tab to list.'),
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Matches order reference, contact email, or the name on the parcel.'),
        param('withItems', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Include line items on every row. The design expands a row in place, so fetching them with the page lets it expand without a round trip.'),
        ...pagingParams,
      ],
      responses: {
        200: json('The page.', object({
          orders: arrayOf(ref('AdminOrder')),
          total: { type: 'integer', description: 'Rows matching the current filter.', example: 2 },
          counts: object({
            all: { type: 'integer', example: 2 },
            processing: { type: 'integer', example: 1 },
            shipped: { type: 'integer', example: 0 },
            delivered: { type: 'integer', example: 1 },
            needs_attention: { type: 'integer', example: 0 },
            unpaid: { type: 'integer', example: 1 },
          }),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/orders/export': {
    get: {
      tags: [TAG],
      summary: 'Export orders as CSV',
      description: [
        'Exports **the current filter**, not everything — what downloads is what the operator is looking at. Capped at 5,000 rows, because an unbounded export of a growing table is a way to take the server down from a button.',
        '',
        '**A truncated export says so.** `X-Total-Rows`, `X-Exported-Rows` and `X-Truncated` come back as headers, and the filename itself becomes `…-FIRST-5000-OF-12345.csv` — because the filename is the only part an operator clicking a download button ever sees, and a silently truncated list is one they will believe is complete.',
        '',
        'Fields beginning `=`, `+`, `-` or `@` are prefixed with an apostrophe so a spreadsheet cannot execute a customer-supplied value as a formula. The file carries a UTF-8 BOM so Excel on Windows renders non-ASCII names correctly.',
      ].join('\n'),
      parameters: [
        param('tab', 'query', { type: 'string', enum: orderTabs, default: 'all' }, 'Same tabs as the listing.'),
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Same search as the listing.'),
      ],
      responses: {
        200: {
          description: 'A CSV attachment.',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/shipping-margin': {
    get: {
      tags: [TAG],
      summary: 'Postage charged against postage paid',
      description: [
        'What we collected for delivery against what it cost us, for paid orders in a window.',
        '',
        '### Why this screen exists',
        'Nothing else joins those two numbers. What we charge is decided at checkout and stored on the order; what we pay arrives weeks later on a separate supplier invoice. That gap is how postage to Ghana ran roughly **£21 below cost per order** without anything erroring — the books had margin, payments settled, and the loss existed only between two documents nobody was comparing.',
        '',
        'Worth checking after switching shipping rates on, and after any rate change — the supplier reissues their price sheets a couple of times a year.',
        '',
        '### Reading it',
        'Amounts are **GBP pence**, and this is the supplier-facing side of the money, so nothing here is converted into a customer currency.',
        '',
        '`comparableOrders` plus `skippedOrders` is every paid order in the window. Skipped ones were priced before delivery options existed, or their destination has since lost its rate — they carry no service code or weight, so there is nothing to recompute from. They are counted rather than guessed at.',
        '',
        '`underwater` is orders shipping below cost, worst first, capped by `limit`; `underwaterCount` is how many there are in total.',
        '',
        '`caveats` is a list of plain-English notes to show alongside the figures. **Render them.** Cost is recomputed from our own rate table rather than a real invoice, and UK orders are costed at the parcel rate because the order does not record whether it went as a large letter — an operator reading the numbers without those two facts will over-read them.',
      ].join('\n'),
      parameters: [
        param('days', 'query', { type: 'integer', minimum: 1, maximum: 3650, default: 90 },
          'How far back to look. The default roughly matches how often rates change.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          'How many below-cost orders to list. `underwaterCount` is unaffected.'),
      ],
      responses: {
        200: json('The margin report.', object({
          days: { type: 'integer', example: 90 },
          totalOrders: { type: 'integer', example: 214 },
          comparableOrders: { type: 'integer', example: 198 },
          skippedOrders: { type: 'integer', example: 16 },
          totalChargedGbpPence: { type: 'integer', example: 184230 },
          totalCostGbpPence: { type: 'integer', example: 255108 },
          totalMarginGbpPence: { type: 'integer', example: -70878, description: 'Negative means we paid to ship.' },
          marginPercent: { type: 'number', nullable: true, example: -38.5 },
          underwaterCount: { type: 'integer', example: 23 },
          underwater: arrayOf(object({
            reference: { type: 'string', example: 'KK-2026-0481' },
            countryCode: { type: 'string', example: 'GH' },
            serviceCode: { type: 'string', example: '011' },
            weightG: { type: 'integer', example: 480 },
            weightEstimated: { type: 'boolean', example: false },
            chargedGbpPence: { type: 'integer', example: 1199 },
            costGbpPence: { type: 'integer', example: 3322 },
            marginGbpPence: { type: 'integer', example: -2123 },
            paidAt: { type: 'string', format: 'date-time', nullable: true },
          }), 'Worst first.'),
          estimatedWeightCount: {
            type: 'integer', example: 7,
            description: 'Orders priced from an assumed book weight — the first thing to check when an invoice disagrees.',
          },
          caveats: arrayOf({ type: 'string' }, 'Show these alongside the figures.'),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/referrals/analytics': {
    get: {
      tags: [TAG],
      summary: 'Referral competition: totals, weekly and cumulative',
      description: [
        'The figures behind the public `/api/v1/referrals/analytics`, computed by the same queries so the console and the app cannot disagree, plus a `travellers` count.',
        '',
        '**Uncached**, unlike the public endpoint: an operator checking a figure after a correction sees it immediately rather than up to five minutes later.',
        '',
        '`sent` is invites and share-sheet opens; `successful` is verified signups (the ones that scored); `countries` is distinct countries of everyone who signed up through a link. `weekly` has one bucket per campaign week, zero or not. See the public endpoint for how weeks are anchored.',
        '',
        '**Two cumulative lines, one per card.** `cumulative` runs over all signups and ends at `totals.signups`; `cumulativeSuccessful` runs over verified signups and ends at `totals.successful`. Plot the one that matches the card beside the chart. Both start from the signups made before week 1, so neither can end below its total.',
      ].join('\n'),
      responses: {
        200: json('Campaign figures.', object({
          totals: object({
            travellers: { type: 'integer', description: 'Everyone with a referral link or who joined through one — the size of the Travellers list.', example: 530 },
            sent: { type: 'integer', example: 1247 },
            clicks: { type: 'integer', example: 1247 },
            signups: { type: 'integer', description: 'Everyone who signed up through a link, verified or not.', example: 412 },
            successful: { type: 'integer', description: 'Verified signups.', example: 389 },
            conversionRate: { type: 'number', description: '`successful ÷ clicks` as a percentage. An upper bound; see the public endpoint.', example: 31.2 },
            countries: { type: 'integer', example: 14 },
            continents: { type: 'integer', example: 3 },
          }),
          weekly: arrayOf(object({
            weekNumber: { type: 'integer', example: 3 },
            weekStart: { type: 'string', format: 'date', example: '2026-07-06' },
            weekEnd: { type: 'string', format: 'date', example: '2026-07-12' },
            sent: { type: 'integer', example: 190 },
            converted: { type: 'integer', description: 'Signups this week, verified or not.', example: 61 },
            successful: { type: 'integer', description: 'Of this week\'s signups, the ones now verified.', example: 57 },
            cumulative: { type: 'integer', description: 'Running total of signups; the last bucket equals `totals.signups`.', example: 284 },
            cumulativeSuccessful: { type: 'integer', description: 'Running total of verified signups; the last bucket equals `totals.successful`.', example: 268 },
          })),
        })),
        ...adminErrors,
      },
    },
  },

  '/admin/console/referrals/travellers': {
    get: {
      tags: [TAG],
      summary: 'Every Traveller in the referral competition',
      description: [
        'A **Traveller** is anyone with a referral link (created the first time they open their invite screen) or anyone who joined through someone else\'s link. Travellers with no signups yet are included — they are who you look at to find stalled referrers.',
        '',
        'Per-row figures match what that person sees on their own invite screen: `signups`/`successful`/`pending` are **direct** referrals only, while `countriesReached` spans their **whole network** at any depth. `points` is counted (not voided) points.',
        '',
        '`sort`: `points` (default), `signups` (verified signups), or `recent` (newest account first). Ties break on user id, so paging never repeats or skips a row.',
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Matches name, email or username.'),
        param('sort', 'query', { type: 'string', enum: ['points', 'signups', 'recent'], default: 'points' }, 'Ordering.'),
        ...pagingParams,
      ],
      responses: {
        200: json('The page.', object({
          travellers: arrayOf(object({
            id: { type: 'integer', example: 42 },
            name: { type: 'string', example: 'Kwame Mensah' },
            username: { type: 'string', nullable: true, example: 'kwame' },
            email: { type: 'string', example: 'kwame@example.com' },
            countryCode: { type: 'string', nullable: true, example: 'GH' },
            city: { type: 'string', nullable: true, example: 'Accra' },
            joinedAt: { type: 'string', format: 'date-time' },
            referredBy: {
              type: 'object',
              nullable: true,
              description: 'Who brought them in. Null for someone who started their own branch.',
              properties: { id: { type: 'integer', example: 7 }, name: { type: 'string', example: 'Ama Owusu' } },
            },
            invitesSent: { type: 'integer', example: 12 },
            clicks: { type: 'integer', example: 30 },
            signups: { type: 'integer', example: 9 },
            successful: { type: 'integer', example: 8 },
            pending: { type: 'integer', description: 'Signed up, not yet verified.', example: 1 },
            countriesReached: { type: 'integer', example: 4 },
            points: { type: 'integer', example: 120 },
          })),
          total: { type: 'integer', example: 530 },
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/customers': {
    get: {
      tags: [TAG],
      summary: 'Customers, with lifetime totals',
      description: [
        'The Customers table and the three cards above it.',
        '',
        '`stats` describes the **whole customer base**, not the current search — that is what the design shows, and a card that changed as you typed would be worse than useless.',
        '',
        'The customer base excludes the accounts the web shop creates for a browser on its first add-to-cart (there are roughly ten of those per real signup). A guest who **completed a purchase** is kept and flagged with `isGuest`; one that never ordered is not a customer and appears in neither the list nor the cards.',
        '',
        '`active` means *seen in the last 12 months* — engagement, not spend. It tracks `lastSignInAt`, which moves on any authenticated request rather than only on password entry, so a mobile client that silently rotates tokens for months still reads as active.',
        '',
        'Per-customer aggregates (`orders`, `totalSpentMinor`, `lastOrderAt`) still count paid orders only — that is where the revenue question is answered.',
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Matches name or email.'),
        ...pagingParams,
      ],
      responses: {
        200: json('The page.', object({
          customers: arrayOf(ref('AdminCustomer')),
          total: { type: 'integer', example: 12 },
          stats: object({
            customers: { type: 'integer', example: 12 },
            active: { type: 'integer', example: 10 },
            inactive: { type: 'integer', example: 2 },
            blacklisted: { type: 'integer', example: 0 },
            totalSpentMinor: { type: 'integer', description: 'Lifetime paid revenue, minor units.', example: 184000 },
          }),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/customers/export': {
    get: {
      tags: [TAG],
      summary: 'Export customers as CSV',
      description: 'Same rules as the orders export: current filter, 5,000-row cap, formula-injection safe, BOM-prefixed.',
      parameters: [param('q', 'query', { type: 'string', maxLength: 200 }, 'Same search as the listing.')],
      responses: {
        200: {
          description: 'A CSV attachment.',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
        ...adminErrors,
      },
    },
  },

  '/admin/console/customers/{id}/blacklist': {
    post: {
      tags: [TAG],
      summary: 'Blacklist a customer',
      description: [
        '**Closes every way in.** Password login, refresh and social sign-in all answer **403 `ACCOUNT_SUSPENDED`**, and their live sessions are revoked on the spot — `sessionsRevoked` says how many. The access token already in hand stays valid until it expires (15 min by default), so checkout and every community route carry their own checks for that window: checkout answers `ACCOUNT_SUSPENDED` — **guest checkout under the same email address included** — and community routes answer `403 ACCOUNT_RESTRICTED`.',
        '',
        '**Their profile and activity disappear for everyone else:** profile, shelf and follow lists answer 404; their posts, reviews and comments drop out of feeds, book pages, comment threads, counts and search; they are left out of group member lists and book-club threads; and they cannot be tagged or followed.',
        '',
        'They are emailed the "Your account has been blacklisted" notice.',
        '',
        '**Groups they own pass to the Kinkané Admin account** (contactus@kinkane.app, created the first time it is needed), which joins each as an active member; the former owner stays a hidden member. contactus@kinkane.app is emailed the list. Ownership stays with Kinkané Admin if the blacklist is lifted.',
        '',
        '**Non-destructive and reversible.** Nothing is deleted, and lifting the blacklist brings everything back as it was: moderation decisions get revisited, and a blacklist that deletes content cannot be undone.',
        '',
        'Idempotent — blacklisting an already-blacklisted customer returns `changed: false` rather than an error.',
      ].join('\n'),
      parameters: [param('id', 'path', { type: 'integer' }, 'Customer id.', { required: true })],
      requestBody: body(object({
        reason: { type: 'string', maxLength: 500, description: 'Shown to no one but the next admin. Optional.', example: 'Duplicate accounts to farm the first-order discount' },
      }), { required: false }),
      responses: {
        200: json('Blacklisted.', object({
          id: { type: 'integer', example: 4412 },
          blacklisted: { type: 'boolean', example: true },
          changed: { type: 'boolean', description: 'False when they were already blacklisted.', example: true },
          sessionsRevoked: { type: 'integer', description: 'Live sessions ended by this call.', example: 2 },
        })),
        400: json('Invalid customer id.', ref('ValidationError')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
    delete: {
      tags: [TAG],
      summary: 'Lift a blacklist',
      description: 'Restores the account. Clears the reason and the admin who set it.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Customer id.', { required: true })],
      responses: {
        200: json('Restored.', object({
          id: { type: 'integer', example: 4412 },
          blacklisted: { type: 'boolean', example: false },
          changed: { type: 'boolean', example: true },
        })),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports': {
    get: {
      tags: [TAG],
      summary: 'The moderation queue',
      description:
        'Ordered pending-first, then newest-first: the screen is a worklist, so anything still needing a decision belongs at the top regardless of age. `counts` covers all three statuses whatever filter is applied.\n\n' +
        'A report is filed against **either a user or a group** — `targetType` says which, and exactly one of `reportedUser` / `reportedGroup` is populated. **`reportedUser` is null on a group report**, so read `targetName` if all you need is a label; it carries whichever target the report is about.\n\n' +
        '`reportedGroup` is also null once a reported group has been deleted: the complaint outlives its target.\n\n' +
        '`?targetType=user` restricts the queue to reports about people, which is the pre-groups behaviour of this endpoint — useful as a stopgap for a console that is not yet ready to render group reports.\n\n' +
        '**Tabs.** `?category=` selects the screen\'s tab: `user` (User Reports), `group` (Group Reports) or `content` (Posts & Reviews). A report about a person that cites a post, review or comment is a `content` report. `pendingByCategory` gives each tab\'s badge, unaffected by the filter.',
      parameters: [
        param('status', 'query', { type: 'string', enum: ['pending', 'resolved', 'dismissed'] }, 'Filter by status. Omit for all.'),
        param('targetType', 'query', { type: 'string', enum: ['user', 'group'] }, 'Filter by what the report is against. Omit for all.'),
        param('category', 'query', { type: 'string', enum: ['user', 'group', 'content'] }, 'The tab. Omit for all.'),
        ...pagingParams,
      ],
      responses: {
        200: json('The queue.', object({
          reports: arrayOf(ref('AdminReport')),
          total: { type: 'integer', example: 4 },
          counts: object({
            pending: { type: 'integer', example: 3 },
            resolved: { type: 'integer', example: 1 },
            dismissed: { type: 'integer', example: 0 },
          }),
          pendingByCategory: object({
            user: { type: 'integer', example: 3 },
            group: { type: 'integer', example: 2 },
            content: { type: 'integer', example: 3 },
          }),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/dismiss': {
    post: {
      tags: [TAG],
      summary: 'Dismiss a report',
      description: 'The complaint was looked at and no action taken. Records who decided and when.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Dismissed.', object({
          id: { type: 'integer', example: 3 },
          status: { type: 'string', example: 'dismissed' },
        })),
        400: json('Invalid report id.', ref('ValidationError')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/blacklist': {
    post: {
      tags: [TAG],
      summary: 'Blacklist the reported user and close the report',
      description: [
        'Blocks the reported account and marks the report resolved.',
        '',
        '**Closes every pending report against that user, not just this one.** Three people reporting the same person is one decision; leaving the other two open means the next admin re-reviews an account that is already blocked. The ids that were closed come back in `resolvedReportIds`.',
      ].join('\n'),
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Blacklisted and resolved.', object({
          resolvedReportIds: arrayOf({ type: 'integer' }, 'Every pending report closed by this action.'),
          blacklistedUserId: { type: 'integer', example: 4412 },
        })),
        400: json('Invalid report id.', ref('ValidationError')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/hide': {
    post: {
      tags: [TAG],
      summary: 'Hide the post, review or comment a report cites',
      description: [
        '"Hide Review", "Hide Post" and "Hide Comment" on the Posts & Reviews tab. The cited content is removed: it disappears for everyone, **its author included**, who is emailed the "Your [post / comment / review] has been removed" notice. Nothing is deleted.',
        '',
        '**Closes every pending report citing the same content.**',
        '',
        'Idempotent: hiding something already hidden changes nothing (`changed: false`) and sends no second email, but still closes its reports.',
      ].join('\n'),
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Hidden.', object({
          kind: { type: 'string', enum: ['post', 'comment', 'groupComment'], example: 'post' },
          id: { type: 'integer', example: 3310 },
          hidden: { type: 'boolean', example: true },
          changed: { type: 'boolean', example: true },
          resolvedReportIds: arrayOf({ type: 'integer' }, 'Every pending report closed by this action.'),
        })),
        400: json('Invalid report id, or `NOTHING_TO_HIDE`: the report cites nothing, or what it cited was deleted.', ref('Error')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/unhide': {
    post: {
      tags: [TAG],
      summary: 'Unhide what a report cites',
      description: 'Undoes hide. A post goes back to the visibility its author last chose. Its reports stay resolved, and no email is sent.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Visible again.', object({
          kind: { type: 'string', enum: ['post', 'comment', 'groupComment'], example: 'post' },
          id: { type: 'integer', example: 3310 },
          hidden: { type: 'boolean', example: false },
          changed: { type: 'boolean', example: true },
        })),
        400: json('Invalid report id, or `NOTHING_TO_HIDE`.', ref('Error')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/blacklist-group': {
    post: {
      tags: [TAG],
      summary: 'Blacklist the reported group and close its reports',
      description: [
        '"Blacklist Group" on the Group Reports tab. The group disappears for everyone, owner and members included: opening it, listing it, searching for it, joining it, editing it and deleting it all answer 404. Nothing in it is deleted.',
        '',
        'The owner is emailed the "Your group has been blacklisted" notice; members are not (`emailed` is 1, or 0 if there was nothing to do). **Closes every pending report about the group.**',
        '',
        'Idempotent: a group already blacklisted is left as it is (`changed: false`) and nobody is emailed again.',
      ].join('\n'),
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Blacklisted.', object({
          groupId: { type: 'integer', example: 12 },
          blacklisted: { type: 'boolean', example: true },
          changed: { type: 'boolean', example: true },
          resolvedReportIds: arrayOf({ type: 'integer' }, 'Every pending report closed by this action.'),
          emailed: { type: 'integer', example: 1 },
        })),
        400: json('Invalid report id, or `NOT_A_GROUP_REPORT`.', ref('Error')),
        404: json('No such report, or the reported group has since been deleted.', ref('Error')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/reports/{id}/unblacklist-group': {
    post: {
      tags: [TAG],
      summary: 'Lift a group blacklist',
      description: 'The group comes back exactly as it was. No email is sent.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Report id.', { required: true })],
      responses: {
        200: json('Restored.', object({
          groupId: { type: 'integer', example: 12 },
          blacklisted: { type: 'boolean', example: false },
          changed: { type: 'boolean', example: true },
        })),
        400: json('Invalid report id, or `NOT_A_GROUP_REPORT`.', ref('Error')),
        404: json('No such report, or the reported group has since been deleted.', ref('Error')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/restock-requests': {
    get: {
      tags: [TAG],
      summary: 'Restock requests, one card per edition',
      description: [
        'The Restock Requests screen. Each card is one **edition** (ISBN): a paperback and a hardback of the same title are separate cards, because restocking at Gardners is per ISBN. A card lists its requests, newest first.',
        '',
        '**Paged by card, not by request**, so one book’s requests are never split across two pages. Cards are ordered by their newest matching request.',
        '',
        '**What the filter does.** `status` and `q` decide which requests appear, and a card appears when it has at least one. On the Fulfilled tab a card shows, and counts, only its fulfilled requests.',
        '',
        '**`counts` follows the search but not the tab**, so "Pending (5)" still says 5 while Fulfilled is open. Like the design, it counts requests, not books. `totalRequests` is the "6 requests" beside the tabs: the requests matching both tab and search.',
        '',
        'A request with no name is shown as *Anonymous*, and one with no email as *No contact details provided*. `anonymous` is true when there is no name.',
        '',
        'Marking a request fulfilled changes nothing but its status. The admin arranges the restock with Gardners and contacts the customer themselves.',
      ].join('\n'),
      parameters: [
        param('status', 'query', { type: 'string', enum: ['all', 'pending', 'fulfilled'], default: 'all' }, 'The tab.'),
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Matches title, author, ISBN, and the customer’s name or email. `%` and `_` match literally.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'Cards per page.'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Cards to skip.'),
      ],
      responses: {
        200: json('The cards.', object({
          cards: arrayOf(object({
            book: object({
              id: { type: 'integer', example: 812 },
              title: { type: 'string', example: 'Wandering Stars' },
              author: { type: 'string', nullable: true, example: 'Tommy Orange' },
              isbn13: { type: 'string', nullable: true, example: '9780593318256' },
              coverUrl: { type: 'string', nullable: true, example: 'https://res.cloudinary.com/…/cover.jpg' },
              format: { type: 'string', nullable: true, example: 'Paperback', description: '`Paperback`, `Hardcover`, or the full ONIX label for anything else.' },
            }),
            requestCount: { type: 'integer', example: 1, description: 'Requests on this card in the current filter: the "1 request" label.' },
            pendingCount: { type: 'integer', example: 1, description: 'Of those, how many are pending. Use it to show or hide "Fulfil all".' },
            requests: arrayOf(object({
              id: { type: 'integer', example: 1 },
              reference: { type: 'string', example: 'RR001' },
              name: { type: 'string', nullable: true, example: 'Amara Diallo' },
              email: { type: 'string', nullable: true, example: 'amara.diallo@email.com' },
              anonymous: { type: 'boolean', example: false },
              userId: { type: 'integer', nullable: true, example: 4412, description: 'Set when the customer was signed in.' },
              status: { type: 'string', enum: ['pending', 'fulfilled'], example: 'pending' },
              requestedAt: { type: 'string', format: 'date-time' },
              fulfilledAt: { type: 'string', format: 'date-time', nullable: true },
            })),
          })),
          totalRequests: { type: 'integer', example: 6 },
          totalCards: { type: 'integer', example: 6 },
          counts: object({
            total: { type: 'integer', example: 6 },
            pending: { type: 'integer', example: 5 },
            fulfilled: { type: 'integer', example: 1 },
          }),
        })),
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/restock-requests/export': {
    get: {
      tags: [TAG],
      summary: 'Export restock requests as CSV',
      description: 'One row per request in **the current tab and search**, newest first. Capped at 5,000 rows, with the same truncation headers and filename as the other exports. Columns: Reference, Requested, Title, Author, Format, ISBN, Customer, Email, Signed in, Status, Fulfilled.',
      parameters: [
        param('status', 'query', { type: 'string', enum: ['all', 'pending', 'fulfilled'], default: 'all' }, 'Same tab as the listing.'),
        param('q', 'query', { type: 'string', maxLength: 200 }, 'Same search as the listing.'),
      ],
      responses: {
        200: {
          description: 'A CSV attachment.',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
        400: json('Validation failed.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/restock-requests/{id}/fulfil': {
    post: {
      tags: [TAG],
      summary: 'Mark one restock request fulfilled',
      description: 'The "Mark fulfilled" button on one person’s row. Records who and when. **Idempotent:** fulfilling a fulfilled request changes nothing, so a double click does not rewrite who dealt with it.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Restock request id.', { required: true })],
      responses: {
        200: json('Fulfilled.', object({
          id: { type: 'integer', example: 1 },
          status: { type: 'string', example: 'fulfilled' },
          fulfilledAt: { type: 'string', format: 'date-time' },
        })),
        400: json('Invalid restock request id.', ref('ValidationError')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/restock-requests/{id}/reopen': {
    post: {
      tags: [TAG],
      summary: 'Undo: move a restock request back to pending',
      description: 'For a request marked fulfilled by mistake. Clears who fulfilled it and when.',
      parameters: [param('id', 'path', { type: 'integer' }, 'Restock request id.', { required: true })],
      responses: {
        200: json('Pending again.', object({
          id: { type: 'integer', example: 1 },
          status: { type: 'string', example: 'pending' },
          fulfilledAt: { type: 'string', nullable: true, example: null },
        })),
        400: json('Invalid restock request id.', ref('ValidationError')),
        404: resp('NotFound'),
        ...adminErrors,
      },
    },
  },

  '/admin/console/restock-requests/books/{bookId}/fulfil': {
    post: {
      tags: [TAG],
      summary: 'Fulfil every pending request on a card',
      description: '"Fulfil all" on one edition’s card: one restock at Gardners answers everyone who asked. Returns the ids it changed, so a mistake can be undone one by one with `reopen`. A card with nothing pending returns an empty list.',
      parameters: [param('bookId', 'path', { type: 'integer' }, 'The card’s book id (`book.id`).', { required: true })],
      responses: {
        200: json('Fulfilled.', object({
          bookId: { type: 'integer', example: 812 },
          fulfilledIds: arrayOf({ type: 'integer' }, 'The requests this marked fulfilled.'),
        })),
        400: json('Invalid book id.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/settings/banners': {
    get: {
      tags: [TAG],
      summary: 'Both announcement banners, with their toggles',
      description: 'Returns **both** slots including disabled ones, because the screen has to draw the switches. The public endpoint (`GET /api/v1/settings/banners`) returns only the enabled ones.',
      responses: {
        200: json('The banners.', object({ banners: arrayOf(ref('AdminBanner')) })),
        ...adminErrors,
      },
    },
    put: {
      tags: [TAG],
      summary: 'Save both announcement banners',
      description: [
        'Saves both slots in one transaction, matching the design’s single Save Changes button. All-or-nothing: a partial write would leave the site showing one banner from before the edit and one from after.',
        '',
        'An enabled banner must have text — an empty enabled strip would render a blank bar on every page, so it is rejected rather than silently hidden.',
        '',
        'Changes are live immediately; the public endpoint is not cached.',
      ].join('\n'),
      requestBody: body(object({
        banners: arrayOf(object({
          slot: { type: 'string', enum: ['top', 'second'], description: '`top` is the red strip, `second` the charcoal one beneath it.' },
          enabled: { type: 'boolean', example: true },
          text: { type: 'string', maxLength: 200, example: 'We Ship Worldwide!' },
        }, ['slot', 'enabled', 'text'])),
      }, ['banners'])),
      responses: {
        200: json('Saved. Returns both banners as they now stand.', object({ banners: arrayOf(ref('AdminBanner')) })),
        400: json('Validation failed — a duplicate slot, or an enabled banner with no text.', ref('ValidationError')),
        ...adminErrors,
      },
    },
  },

  '/admin/console/notifications': {
    get: {
      tags: [TAG],
      summary: 'The notification feed',
      description: [
        'What the bell shows: newest first, with an unread count.',
        '',
        '**Read state is shared across admins**, not per-person. With a small team working one queue, "somebody has seen this" is the useful meaning, and a per-admin join table is more machinery than the bell is worth.',
        '',
        'Three of the four event types fire today: `report_filed`, `order_received` and `customer_registered`. **`order_delivered` never fires yet** — nothing in the system marks an order delivered, because there is no delivery signal from the courier. The type exists so the feed does not need changing when one arrives.',
      ].join('\n'),
      responses: {
        200: json('The feed.', object({
          notifications: arrayOf(ref('AdminNotification')),
          unread: { type: 'integer', example: 3 },
        })),
        ...adminErrors,
      },
    },
    delete: {
      tags: [TAG],
      summary: 'Clear the feed',
      description: 'Empties it. The events themselves live on in `orders`, `users` and `user_reports` — this only discards the bell entries.',
      responses: {
        200: json('Cleared.', object({ cleared: { type: 'integer', example: 12 } })),
        ...adminErrors,
      },
    },
  },

  '/admin/console/notifications/read-all': {
    post: {
      tags: [TAG],
      summary: 'Mark everything read',
      description: 'Clears the unread badge for every admin, since read state is shared.',
      responses: {
        200: json('Marked.', object({ marked: { type: 'integer', example: 3 } })),
        ...adminErrors,
      },
    },
  },

  '/api/v1/settings/banners': {
    get: {
      tags: ['Shop'],
      ...publicEndpoint,
      summary: 'Announcement banners for the storefront',
      description: [
        'The strips rendered at the top of every storefront page, controlled from the admin console’s Settings screen.',
        '',
        '**Only enabled banners come back.** A storefront has no business knowing the copy of a banner it is not showing, and returning disabled ones invites a client to cache one and render it after it was switched off.',
        '',
        '`slot` says where it goes: `top` is the red strip, `second` the charcoal one beneath it. An empty array means show neither.',
        '',
        '**The 15% first-order discount is not driven by this.** The banner is copy; the discount is `FIRST_ORDER_DISCOUNT_PERCENT`. Switching one off does not switch off the other.',
      ].join('\n'),
      responses: {
        200: json('The banners to show, in stack order.', object({
          banners: arrayOf(object({
            slot: { type: 'string', enum: ['top', 'second'], example: 'top' },
            text: { type: 'string', example: 'We Ship Worldwide!' },
          })),
        })),
        500: resp('ServerError'),
      },
    },
  },
};
