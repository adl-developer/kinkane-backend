import {
  ref, resp, json, body, object, arrayOf, authErrors,
} from '../helpers';

const TAG = 'Subscription';

const cancelReasonSchema = {
  reason: {
    type: 'string',
    enum: ['not_using', 'accidental', 'too_expensive', 'other'],
    description: 'Why they are leaving. Required whenever the effect is a cancellation.',
    example: 'too_expensive',
  },
  reasonOther: {
    type: 'string', minLength: 1, maxLength: 500,
    description: 'Required when `reason` is `other`, ignored otherwise.',
    example: 'Moving to a different reading app.',
  },
};

const subscriptionStateResponse = object({
  cancelAtPeriodEnd: { type: 'boolean', example: true },
  accessEndsAt: {
    type: 'string', format: 'date-time',
    description: 'Plus remains fully available until this moment.',
    example: '2027-03-01T00:00:00.000Z',
  },
  tier: { type: 'string', example: 'plus' },
  status: { type: 'string', example: 'active' },
});

export const billingPaths = {
  '/api/v1/user/subscription': {
    get: {
      tags: [TAG],
      summary: 'Get the current subscription',
      description: [
        'The single source of truth for the paywall and the account screen.',
        '',
        'Two fields decide what UI to show before anything else:',
        '- **`paymentsAvailable`** — false when Stripe is not configured on this deployment. Hide purchase UI entirely rather than letting the buttons 503.',
        '- **`foundingOfferActive`** / **`foundingOfferEndsAt`** — whether this user is still inside their founding window (their first `FOUNDING_PERIOD_MONTHS` months after sign-up, 3 by default) and when it closes. Distinct from `isFoundingMember`, which is whether they are paying a founding price right now.',
        '',
        '**The trial is ours, not Stripe’s.** A `trialing` user has no Stripe subscription behind them, which is why `/cancel` returns 409 `NO_PAID_SUBSCRIPTION` for them — there is genuinely nothing to cancel.',
      ].join('\n'),
      responses: {
        200: json('The subscription.', ref('Subscription')),
        401: resp('Unauthorized'),
        404: json('No subscription row for this account.', ref('Error'), { error: 'No subscription found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/history': {
    get: {
      tags: [TAG],
      summary: 'Subscription history',
      description:
        'Every state the subscription has been in, newest first. Each entry is a state and the window it was in force for — `effectiveTo` is null on the current one.',
      responses: {
        200: json('The history.',
          object({
            history: arrayOf(object({
              tier: { type: 'string', example: 'plus' },
              status: { type: 'string', example: 'active' },
              plan: { type: 'string', nullable: true, example: 'annual' },
              isFoundingMember: { type: 'boolean', example: true },
              cancelAtPeriodEnd: { type: 'boolean', example: false },
              reason: {
                type: 'string', nullable: true,
                description: 'What caused the transition — checkout, trial expiry, cancellation, a Stripe webhook.',
                example: 'checkout_completed',
              },
              effectiveFrom: { type: 'string', format: 'date-time', example: '2026-03-01T00:00:00.000Z' },
              effectiveTo: {
                type: 'string', format: 'date-time', nullable: true,
                description: 'Null on the state currently in force.',
                example: null,
              },
            })),
          })),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/subscription/plans': {
    get: {
      tags: [TAG],
      summary: 'Get purchasable plans and live prices',
      description:
        'Prices are read from Stripe at call time so **the client never hardcodes an amount**.\n\nInside the user’s founding window (their first `FOUNDING_PERIOD_MONTHS` months after sign-up, 3 by default) the returned `amountCents` are the Founding Member prices, with `standardAmountCents` alongside so the saving can be shown without a second source of truth.',
      responses: {
        200: json('The available plans.',
          object({
            foundingOfferActive: { type: 'boolean', example: true },
            foundingOfferEndsAt: { type: 'string', format: 'date-time', nullable: true, description: 'When this user’s founding window closes; null once it has.', example: '2027-02-09T10:00:00.000Z' },
            plans: arrayOf(object({
              plan: { type: 'string', enum: ['monthly', 'annual'], example: 'annual' },
              amountCents: {
                type: 'integer',
                description: 'What this user would actually be charged today, in minor units.',
                example: 4999,
              },
              standardAmountCents: {
                type: 'integer',
                description: 'The non-promotional price, for showing the saving. Equal to `amountCents` outside the user’s founding window.',
                example: 5999,
              },
              currency: { type: 'string', example: 'USD' },
              interval: { type: 'string', enum: ['month', 'year'], example: 'year' },
              isFounding: { type: 'boolean', example: true },
            })),
          })),
        401: resp('Unauthorized'),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/checkout-session': {
    post: {
      tags: [TAG],
      summary: 'Start a subscription checkout',
      description: [
        'Creates a Stripe Checkout session and returns its URL.',
        '',
        '**The client names a plan, never a price.** Prices are resolved server-side from `plan` plus whether the user’s founding window is open, so a crafted request cannot choose what it pays.',
        '',
        '`successUrl` and `cancelUrl` are optional overrides and **must be on the Kinkané origin** — an off-origin URL is rejected, so this cannot be turned into an open redirect.',
        '',
        '**Rate limit:** 20 per hour.',
      ].join('\n'),
      requestBody: body(object({
        plan: { type: 'string', enum: ['monthly', 'annual'], example: 'annual' },
        successUrl: { type: 'string', format: 'uri', description: 'Must be on the Kinkané origin.', example: 'https://kinkane.app/account/subscription?checkout=success' },
        cancelUrl: { type: 'string', format: 'uri', description: 'Must be on the Kinkané origin.', example: 'https://kinkane.app/account/subscription?checkout=cancelled' },
      }, ['plan'])),
      responses: {
        200: json('Send the user to `url`.',
          object({
            url: { type: 'string', format: 'uri', example: 'https://checkout.stripe.com/c/pay/cs_test_a1B2…' },
            sessionId: { type: 'string', example: 'cs_test_a1B2c3D4…' },
            plan: { type: 'string', example: 'annual' },
            isFounding: { type: 'boolean', example: true },
          })),
        400: resp('ValidationError'),
        409: json('This account already has an active paid subscription.', ref('Error'),
          { error: 'Already subscribed' }),
        503: resp('PaymentsUnavailable'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/subscription/cancel': {
    post: {
      tags: [TAG],
      summary: 'Cancel the subscription',
      description: [
        'Cancels in-app — no Stripe-hosted page and no webview. Sending someone to a Stripe-branded site to stop paying is a poor experience, and cancellation is one flag rather than one of the genuinely hard billing flows (proration, dunning, SCA) that stay in the portal.',
        '',
        '**Takes effect at the end of the paid period, never immediately.** The user has already paid for this term; revoking it on click destroys value they bought and invites refund requests. Plus stays available until `accessEndsAt`.',
        '',
        '**Idempotent** — cancelling twice returns the same state rather than an error.',
        '',
        'Reversible while the period is still running: see `/reactivate`.',
      ].join('\n'),
      responses: {
        200: json('Scheduled to end at `accessEndsAt`.', subscriptionStateResponse),
        401: resp('Unauthorized'),
        404: json('No subscription row.', ref('Error'), { error: 'No subscription found' }),
        409: json(
          '`NO_PAID_SUBSCRIPTION` — the account is free or on the trial. The trial is ours rather than Stripe’s, so there is nothing to cancel; it simply lapses.',
          ref('Error'),
          { error: 'No paid subscription to cancel', code: 'NO_PAID_SUBSCRIPTION' }),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/reactivate': {
    post: {
      tags: [TAG],
      summary: 'Undo a scheduled cancellation',
      description:
        'Clears `cancelAtPeriodEnd` while the period is still running — the request that always follows a cancel button.\n\nWithout it, someone who cancelled by accident could only come back via a fresh checkout, which means a new billing date and, once their founding window has closed, **losing their Founding Member price permanently**.',
      responses: {
        200: json('Reactivated; billing continues as before.',
          object({
            cancelAtPeriodEnd: { type: 'boolean', example: false },
            accessEndsAt: { type: 'string', format: 'date-time', example: '2027-03-01T00:00:00.000Z' },
            tier: { type: 'string', example: 'plus' },
            status: { type: 'string', example: 'active' },
          })),
        401: resp('Unauthorized'),
        404: json('No subscription row.', ref('Error'), { error: 'No subscription found' }),
        409: json(
          'Either `NO_PAID_SUBSCRIPTION`, or `SUBSCRIPTION_ENDED` — the period already elapsed and Stripe deleted the subscription, so there is nothing left to reactivate and the user must start a new one.',
          ref('Error'),
          { error: 'This subscription has already ended', code: 'SUBSCRIPTION_ENDED' }),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/change': {
    post: {
      tags: [TAG],
      summary: 'Switch plan',
      description: [
        'Moves between monthly, annual and free, effective at the end of the current period.',
        '',
        '### Re-authentication is required',
        'Exactly one of these must be sent — both, or neither, is a 400:',
        '- **`password`** — for accounts that have one.',
        '- **`idToken`** — for social accounts, which do not. It must be **fresh**: `auth_time` within the last 5 minutes, so the client is expected to prompt a re-sign-in rather than reuse a cached token.',
        '',
        '### `plan: "free"` is a cancellation',
        'It is the same underlying action as `POST /cancel`, so it also requires `reason` (and `reasonOther` when the reason is `other`). Every cancellation flows through the reasons ledger regardless of which button reached it.',
        '',
        '### One pending change at a time',
        'While a switch is pending, every plan (including `free`) is refused with `409 PLAN_CHANGE_PENDING`. The user must withdraw it with `DELETE /change` first. `POST /cancel` is not blocked and clears the pending switch.',
        '',
        '**Rate limit:** 20 per hour.',
      ].join('\n'),
      requestBody: body(object({
        plan: {
          type: 'string', enum: ['monthly', 'annual', 'free'],
          description: '`free` cancels — see above.',
          example: 'annual',
        },
        password: { type: 'string', description: 'For password accounts. Mutually exclusive with `idToken`.', example: 'Correct-Horse9' },
        idToken: { type: 'string', description: 'For social accounts. Must be under 5 minutes old.' },
        ...cancelReasonSchema,
      }, ['plan'])),
      responses: {
        200: json('The change is scheduled.',
          object({
            currentPlan: { type: 'string', nullable: true, example: 'monthly' },
            pendingPlan: {
              type: 'string', nullable: true,
              description: 'What it becomes at `effectiveAt`.',
              example: 'annual',
            },
            effectiveAt: { type: 'string', format: 'date-time', example: '2027-03-01T00:00:00.000Z' },
            tier: { type: 'string', example: 'plus' },
            status: { type: 'string', example: 'active' },
          })),
        400: json('Validation failed, or neither/both credentials were supplied, or `reason` is missing on a downgrade to free.',
          ref('ValidationError')),
        401: json('Wrong password, or the ID token is stale — prompt a re-sign-in and retry.', ref('Error'),
          { error: 'Please sign in again to confirm this change' }),
        404: json('No subscription row.', ref('Error'), { error: 'No subscription found' }),
        409: json(
          '`NO_PAID_SUBSCRIPTION`, `PENDING_CANCELLATION` (call `/reactivate` first — a plan change on top of a scheduled cancellation is ambiguous), `PLAN_CHANGE_PENDING` (call `DELETE /change` first; the body also carries `pendingPlan` and `effectiveAt`), `MANAGED_BY_APPLE`, or the account is already on the requested plan.',
          ref('Error'),
          {
            error: 'Cancel your pending switch to annual before changing plans again',
            code: 'PLAN_CHANGE_PENDING',
            pendingPlan: 'annual',
            effectiveAt: '2027-03-01T00:00:00.000Z',
          }),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
    delete: {
      tags: [TAG],
      summary: 'Cancel a pending plan switch',
      description: [
        'Withdraws a switch scheduled with `POST /change`. The user stays on their current plan and renews on it as before; a Founding Member still moves to the standard price when their founding window ends.',
        '',
        'No password is needed: this only restores what the user already had. To cancel the subscription itself, use `POST /cancel`.',
        '',
        '**Rate limit:** 20 per hour.',
      ].join('\n'),
      responses: {
        200: json('The pending switch is cancelled.',
          object({
            currentPlan: { type: 'string', nullable: true, example: 'monthly' },
            pendingPlan: { type: 'string', nullable: true, example: null },
            effectiveAt: {
              type: 'string', format: 'date-time',
              description: 'When the current plan next renews.',
              example: '2027-03-01T00:00:00.000Z',
            },
            tier: { type: 'string', example: 'plus' },
            status: { type: 'string', example: 'active' },
          })),
        401: resp('Unauthorized'),
        404: json('No subscription row.', ref('Error'), { error: 'No subscription found' }),
        409: json('`NO_PENDING_CHANGE` (nothing to cancel), or `MANAGED_BY_APPLE`.', ref('Error'),
          { error: 'You have no pending plan change to cancel', code: 'NO_PENDING_CHANGE' }),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/apple/offer': {
    post: {
      tags: [TAG],
      summary: 'Get the signed founding offer for an App Store purchase',
      description: [
        'Inside the user’s founding window (their first `FOUNDING_PERIOD_MONTHS` months after sign-up, 3 by default) this returns a signed **promotional offer** for the plan; pass it to StoreKit with the purchase (`Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`) together with `appAccountToken`. Apple bills the founding price for the periods the offer covers, then the standard price.',
        '',
        'Monthly gets founding pricing on every renewal that starts before the window closes; annual gets it for the first year.',
        '',
        '`offer: null` means the window has closed: buy at the standard price with no offer. Fetch this right before purchasing — Apple only accepts a signature for a short time.',
        '',
        '**Rate limit:** 60 per hour.',
      ].join('\n'),
      requestBody: body(object({
        plan: { type: 'string', enum: ['monthly', 'annual'], example: 'monthly' },
      }, ['plan'])),
      responses: {
        200: json('The offer, or null.', object({
          offer: {
            type: 'object',
            nullable: true,
            properties: {
              productId: { type: 'string', example: 'app.kinkane.plus.monthly' },
              offerId: { type: 'string', example: 'founding_monthly_3m' },
              keyId: { type: 'string', example: 'ABC123DEFG' },
              nonce: { type: 'string', format: 'uuid' },
              timestamp: { type: 'integer', description: 'Milliseconds since the epoch.', example: 1762682400000 },
              signature: { type: 'string', description: 'Base64.' },
              appAccountToken: { type: 'string', format: 'uuid' },
            },
          },
        })),
        400: json('`plan` missing or invalid.', ref('ValidationError')),
        401: resp('Unauthorized'),
        409: json('`STRIPE_SUBSCRIPTION_ACTIVE`: already paying on the web, so an App Store purchase would bill twice.', ref('Error')),
        429: resp('RateLimited'),
        503: resp('AppleIapUnavailable'),
      },
    },
  },

  '/api/v1/user/subscription/apple/verify': {
    post: {
      tags: [TAG],
      summary: 'Verify an App Store purchase',
      description: [
        'Called by the iOS app after an App Store purchase or a restore. The server asks Apple about the transaction, links that App Store subscription to this account and switches Plus on.',
        '',
        '### Client flow',
        '1. Read `appleAppAccountToken` from `GET /user/subscription` and pass it as the purchase’s `appAccountToken`.',
        '2. After the purchase succeeds, send its `transactionId` here.',
        '3. **Finish the StoreKit transaction only after this returns 200.** If the request never lands, StoreKit redelivers the transaction on the next launch and the app can retry.',
        '',
        'The transaction id is only a pointer: what was bought, and whether it is still active, is read from Apple with the server’s own credentials. Calling again with the same transaction is harmless. Sandbox purchases (TestFlight, App Review) are accepted.',
        '',
        'Renewals, cancellations and refunds after this arrive from Apple directly at `/apple/notifications`, so the app does not need to call this again on every launch, though doing so on restore is fine.',
        '',
        '**Rate limit:** 20 per hour.',
      ].join('\n'),
      requestBody: body(object({
        transactionId: {
          type: 'string',
          pattern: '^\\d{1,32}$',
          description: 'StoreKit’s transaction id. Any transaction in the subscription works.',
          example: '2000000123456789',
        },
      }, ['transactionId'])),
      responses: {
        200: json('Verified; the subscription now, with `provider: "apple"`.', ref('Subscription')),
        400: json('`transactionId` missing or not a StoreKit id.', ref('ValidationError')),
        401: resp('Unauthorized'),
        404: json('Apple has no such Kinkané Plus transaction.', ref('Error'),
          { error: 'That purchase could not be found with the App Store', code: 'APPLE_TRANSACTION_NOT_FOUND' }),
        409: json(
          [
            'One of:',
            '- `APPLE_SUBSCRIPTION_IN_USE`: this App Store subscription is already linked to another Kinkané account.',
            '- `APPLE_ACCOUNT_MISMATCH`: it was bought while signed in to a different Kinkané account (its `appAccountToken` belongs to someone else).',
            '- `APPLE_SUBSCRIPTION_INACTIVE`: it has expired or been refunded, so there is nothing to restore.',
            '- `STRIPE_SUBSCRIPTION_ACTIVE`: this account already pays on the website. The App Store purchase is not applied; the user should ask Apple for a refund.',
          ].join('\n'),
          ref('Error'),
          { error: 'This App Store subscription is already linked to a different Kinkané account', code: 'APPLE_SUBSCRIPTION_IN_USE' }),
        429: resp('RateLimited'),
        502: json('The App Store could not be reached. Retry later; do not finish the transaction.', ref('Error'),
          { error: 'The App Store could not be reached — please try again', code: 'APPLE_IAP_UPSTREAM' }),
        503: json('App Store purchases are not configured on this deployment.', ref('Error'),
          { error: 'App Store purchases are not available right now', code: 'APPLE_IAP_UNAVAILABLE' }),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/subscription/apple/notifications': {
    post: {
      tags: [TAG],
      summary: 'App Store Server Notifications (Apple only)',
      description: [
        'Apple’s App Store Server Notifications **V2** endpoint. Not for clients. Enter this URL in App Store Connect for both Production and Sandbox.',
        '',
        'Nothing in the body is trusted. The notification only names a transaction, and the server re-reads that subscription from Apple before writing anything, so a forged request can at most trigger a refresh. Deliveries are de-duplicated by `notificationUUID`.',
        '',
        'Always answers 200 once a notification is recorded, including ones that are ignored or whose handling failed (those are stored and repaired by the daily reconciliation). Only a body that is not a notification gets a 400, since Apple retries any non-2xx.',
      ].join('\n'),
      security: [],
      requestBody: body(object({
        signedPayload: { type: 'string', description: 'The JWS Apple sends.' },
      }, ['signedPayload'])),
      responses: {
        200: json('Recorded.', object({
          received: { type: 'boolean', example: true },
          duplicate: { type: 'boolean', description: 'Present on a redelivery.', example: true },
        })),
        400: json('Not an App Store notification.', ref('Error'), { error: 'Missing signedPayload' }),
        503: json('App Store purchases are not configured.', ref('Error'),
          { error: 'App Store purchases are not configured' }),
      },
    },
  },
};
