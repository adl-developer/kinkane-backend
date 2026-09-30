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
        '- **`foundingOfferActive`** — whether the launch pricing is still open to *new* subscribers, as distinct from `isFoundingMember`, which is whether *this* user already has it.',
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
        'Prices are read from Stripe at call time so **the client never hardcodes an amount**.\n\nDuring the launch window the returned `amountCents` are the Founding Member prices, with `standardAmountCents` alongside so the saving can be shown without a second source of truth.',
      responses: {
        200: json('The available plans.',
          object({
            foundingOfferActive: { type: 'boolean', example: true },
            foundingOfferEndsAt: { type: 'string', format: 'date-time', nullable: true, example: '2026-12-31T23:59:59.000Z' },
            plans: arrayOf(object({
              plan: { type: 'string', enum: ['monthly', 'annual'], example: 'annual' },
              amountCents: {
                type: 'integer',
                description: 'What this user would actually be charged today, in minor units.',
                example: 4999,
              },
              standardAmountCents: {
                type: 'integer',
                description: 'The non-promotional price, for showing the saving. Equal to `amountCents` outside the launch window.',
                example: 7999,
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
        '**The client names a plan, never a price.** Prices are resolved server-side from `plan` plus whether the launch window is open, so a crafted request cannot choose what it pays.',
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
        'Clears `cancelAtPeriodEnd` while the period is still running — the request that always follows a cancel button.\n\nWithout it, someone who cancelled by accident could only come back via a fresh checkout, which means a new billing date and, during the launch window, **losing their Founding Member price permanently**.',
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
          '`NO_PAID_SUBSCRIPTION`, `PENDING_CANCELLATION` (call `/reactivate` first — a plan change on top of a scheduled cancellation is ambiguous), or the account is already on the requested plan.',
          ref('Error'),
          { error: 'Reactivate your subscription before changing plan', code: 'PENDING_CANCELLATION' }),
        429: resp('RateLimited'),
        503: resp('PaymentsUnavailable'),
        500: resp('ServerError'),
      },
    },
  },
};
