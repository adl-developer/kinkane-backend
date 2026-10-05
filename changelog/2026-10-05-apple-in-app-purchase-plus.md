# Kinkané Plus can be bought through the App Store

## What changed

Until now Kinkané Plus could only be paid for through Stripe on the website.
The server can now accept a subscription bought inside the iOS app and billed
by Apple, and keeps it in step as Apple renews, cancels or refunds it.

- **`POST /api/v1/user/subscription/apple/verify`** (signed in): the iOS app
  sends the transaction id of a purchase or restore. The server asks Apple
  about it, links that App Store subscription to the account and switches Plus
  on. It returns the same body as `GET /user/subscription`.
- **`POST /api/v1/user/subscription/apple/notifications`** (Apple only): App
  Store Server Notifications V2. Renewals, failed payments, auto-renew being
  turned off or on, plan changes, expiry, refunds and Family Sharing
  revocations all update the member's state.
- **`GET /user/subscription`** has three new fields:
  - `provider`: `"stripe"`, `"apple"` or `null` if they've never paid.
  - `appleIapAvailable`: whether App Store purchases are configured.
  - `appleAppAccountToken`: a UUID the app passes when starting a purchase.

  `pendingPlan`, which the endpoint already returned, is now documented.
- Cancel, change plan and reactivate return **409 `MANAGED_BY_APPLE`** for
  App Store subscribers, with `manageUrl` pointing at Apple's subscriptions
  page. Only Apple can change those subscriptions.
- A web checkout is refused for someone whose App Store subscription is still
  active, so nobody gets billed twice.
- The daily reconciliation now also re-reads every live App Store subscription
  from Apple and repairs any drift.

## Data model

Migration `0070_apple_in_app_purchase`:

- `user_subscriptions`: `billing_provider` (enum `stripe` | `apple`),
  `apple_original_transaction_id` (unique) and `apple_environment`.
- `subscription_state_history`: `billing_provider` and
  `apple_original_transaction_id`, so the history shows who was billing.
- `subscription_events`: `apple_transaction_id` and `apple_notification_id`,
  the Apple counterparts of the Stripe ids.
- New `apple_notification_events` table: the delivery log, keyed by Apple's
  `notificationUUID`. It works like `stripe_webhook_events`.
- Backfill: every row with a `stripe_subscription_id` gets
  `billing_provider = 'stripe'`.

## Non-obvious decisions

- **Nothing Apple-shaped from outside is trusted.** Neither the app's
  transaction id nor the notification body is taken as proof. Both only name
  a transaction, and the server then reads the subscription from Apple's API
  with its own key. So notification signatures aren't checked: a forged
  notification can at most make the server re-read the truth. Checking the
  certificate chain needs Apple's root certificate in the deployment, which
  can be added later.
- **One App Store subscription, one account.** The unique index on
  `apple_original_transaction_id` stops one purchase being restored onto
  several accounts. `appAccountToken` is an HMAC of the user id, so it needs
  no storage. It also rejects a purchase made while the device was signed in
  to a different Kinkané account.
- **Each billing system only writes the rows it owns.** Stripe webhooks, apart
  from a new checkout, ignore Apple-billed users. Apple never overwrites an
  active Stripe subscriber. Stripe reconciliation only looks at Stripe-billed
  rows. Without this, a late "subscription deleted" event from a user's old web
  subscription would downgrade them while Apple is billing them.
- **The trial sweep counts Apple payers as paid.** The guard that stopped the
  trial expiry downgrading Stripe payers now covers
  `apple_original_transaction_id` too.
- **An expired purchase can't end a running trial.** A lapsed Apple
  subscription only updates the row it is already linked to. Verify answers
  409 `APPLE_SUBSCRIPTION_INACTIVE` instead.
- **Grace period keeps Plus; billing retry doesn't.** In a grace period Apple
  is still collecting, which matches Stripe's `past_due`. Billing retry
  without a grace period can last 60 days, so it's recorded as `past_due` with
  tier `free`, as Apple's guidance says.
- **Sandbox purchases are accepted in production** (`APPLE_IAP_ALLOW_SANDBOX`,
  default true). App Review tests against the production server with sandbox
  accounts. The only exposure is TestFlight testers getting Plus.
- **Unlinked notifications are skipped.** `SUBSCRIBED` often arrives before
  the app's verify call. The app should finish the StoreKit transaction only
  after verify succeeds, so StoreKit redelivers the purchase until it's
  linked.

## Fixes from code review

- **Stripe members with no label are still treated as Stripe-billed.**
  `billing_provider` can be null on a Stripe row written before this change.
  `getBillingProvider()` reads a null provider with a Stripe subscription id as
  `stripe`, and every ownership check uses it. Every Stripe write now sets the
  label, and the Stripe reconciliation covers unlabelled rows and labels them.
- **Apple retries notifications that failed because Apple was unreachable.**
  The claim is left open and Apple gets a 503, so it redelivers. Handler bugs
  are still recorded and answered 200, because a retry would fail the same way.
- **Unlinked notifications cost no Apple API call.** The subscription's link
  to an account is checked before anything is written or fetched. The endpoint
  also has its own per-IP rate limit of 600 a minute.
- **Billing recovery counts as a renewal.** A conversion is now detected from
  the subscription's status, not its tier, so a member recovering from billing
  retry doesn't get a second welcome email.
- **Two accounts linking the same purchase at once** get 409
  `APPLE_SUBSCRIPTION_IN_USE` instead of a 500 from the unique index.
- **Apple writes clear `isFoundingMember`.** A former Stripe founding member
  doesn't show founding pricing on an App Store subscription.
- **The claim/reclaim logic is shared.** It lives in `lib/delivery-claim.ts`
  and is used by both the Stripe and Apple endpoints.

## What's explicitly out of scope (for now)

- **The iOS app itself:** the purchase screen, StoreKit, `appAccountToken`,
  calling verify, and hiding Stripe controls when `provider` is `apple`.
- **Founding Member pricing on iOS.** Apple purchases are recorded with
  `isFoundingMember: false`. If launch pricing should apply in the app, it
  needs an App Store introductory offer and a decision on how to recognise it.
- **Plans endpoint.** `GET /plans` still returns Stripe prices only. The app
  shows App Store prices from StoreKit, which is what Apple requires.
- **Account deletion with a renewing App Store subscription.** The server
  can't cancel it, so it logs a warning. The app should tell the user to cancel
  in Settings first.
- **Notification signature verification** (see above).

## Configuration

These go in `.env` (all optional; without them the Apple routes return 503):
`APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY` (the .p8
contents), `APPLE_BUNDLE_ID`, `APPLE_PRODUCT_PLUS_MONTHLY`,
`APPLE_PRODUCT_PLUS_ANNUAL` and `APPLE_IAP_ALLOW_SANDBOX`. In App Store
Connect, set the Server Notifications V2 URL for both Production and Sandbox to
`https://<api host>/api/v1/user/subscription/apple/notifications`.

## Testing done

- New `apple-subscriptions.test.ts` with 21 cases, using a mocked Apple API
  and state writer. It covers:
  - linking and conversion;
  - verifying the same purchase twice;
  - a subscription already linked to another account;
  - an `appAccountToken` mismatch;
  - an active Stripe subscriber;
  - taking over from an ended Stripe subscription;
  - an expired purchase against a running trial;
  - auto-renew off, status mapping, refunds and pending plan changes;
  - notifications re-read from Apple rather than trusted;
  - renewal amounts, unlinked chains, duplicates, another app's bundle id and
    malformed bodies.
- `trial-expiry.test.ts`: an App Store payer is never expired.
- `subscription-cancel.test.ts`: an App Store subscriber gets
  `MANAGED_BY_APPLE` from cancel and reactivate, and Stripe is never called.
- `billing-provider-guards.test.ts`: covers both directions.
  - Stripe webhooks don't touch an Apple-billed member.
  - An unlabelled Stripe row gets labelled.
  - Web checkout is refused while an App Store subscription is live, and
    allowed once it has ended.

  Removing a guard makes the matching test fail.
- The Apple suite has 29 cases, now also covering retries, unlinked chains,
  billing recovery, the linking race and the founding flag.
- Full unit suite: 78 files, 1,255 tests passing. `tsc --noEmit` is clean.
- The ES256 API token was checked with a generated key: header `kid`, claims
  `iss`, `aud=appstoreconnect-v1`, `bid`, `iat` and `exp`.
- **Not yet tested against Apple.** That needs the App Store Connect key,
  products and a sandbox account.
