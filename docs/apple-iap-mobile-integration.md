# Kinkané Plus: App Store purchase integration (iOS)

Your package handles the purchase with Apple. Once it succeeds, you send the backend the purchase's **transaction ID**. The backend checks that ID with Apple, links the subscription to the signed-in Kinkané account and switches Plus on.

After that, Apple notifies the backend directly about renewals, cancellations, refunds and failed payments. You don't need to report those.

---

## The flow

1. **Before the purchase:** call `GET /api/v1/user/subscription` and read `appleAppAccountToken`.
2. **Start the purchase** with your package, passing that value as `appAccountToken` (it may be called `appAccountToken` or `applicationUsername`, depending on the package).
3. **After the purchase succeeds,** call `POST /api/v1/user/subscription/apple/verify` with the transaction ID.
4. **Only after that returns 200,** finish / acknowledge the transaction in your package. If the call fails, don't finish it. StoreKit redelivers unfinished transactions on the next launch, so you can retry.
5. Update the paywall from the verify response. It has the same shape as `GET /user/subscription`.

**Restore purchases:** call verify with the restored transaction's ID. Calling it more than once for the same purchase is fine.

---

## Endpoint: verify a purchase

```
POST /api/v1/user/subscription/apple/verify
Authorization: Bearer <access token>
Content-Type: application/json
```

**Body**

```json
{ "transactionId": "2000000123456789" }
```

- `transactionId`: the StoreKit transaction ID, a string of digits. Any transaction in the subscription works, including the original one.
- Send the transaction ID, not a "subscribed" flag. The server checks it with Apple, so a purchase can't be faked.
- Rate limit: 20 requests per hour per user.

**200 response:** the user's subscription, now with `provider: "apple"` (see [Subscription fields](#subscription-fields)).

```json
{
  "tier": "plus",
  "status": "active",
  "plan": "monthly",
  "provider": "apple",
  "trialEndsAt": "2026-12-01T10:00:00.000Z",
  "trialDaysLeft": null,
  "currentPeriodEnd": "2026-11-05T00:00:00.000Z",
  "cancelAtPeriodEnd": false,
  "pendingPlan": null,
  "isFoundingMember": false,
  "hasBillingAccount": false,
  "foundingOfferActive": false,
  "paymentsAvailable": true,
  "appleIapAvailable": true,
  "appleAppAccountToken": "3f1c2a9e-7b4d-4e2a-9c1f-5d6e7f8a9b0c"
}
```

**Errors.** Every error body is `{ "error": "<message>", "code": "<CODE>" }`.

| Status | `code` | Meaning | What the app should do |
| --- | --- | --- | --- |
| 400 | — | `transactionId` missing or not digits | Fix the request |
| 401 | — | Not signed in, or the token expired | Refresh the token and retry |
| 404 | `APPLE_TRANSACTION_NOT_FOUND` | Apple doesn't know this transaction, or it isn't a Plus product | Show an error; don't finish the transaction |
| 409 | `APPLE_SUBSCRIPTION_IN_USE` | This App Store subscription is already linked to another Kinkané account | Tell the user it belongs to another account; finish the transaction |
| 409 | `APPLE_ACCOUNT_MISMATCH` | Bought while signed in to a different Kinkané account | Ask them to sign in to the account they bought it on; finish the transaction |
| 409 | `APPLE_SUBSCRIPTION_INACTIVE` | The subscription has expired or been refunded | "Nothing to restore"; finish the transaction |
| 409 | `STRIPE_SUBSCRIPTION_ACTIVE` | They already pay on the website | Tell them they're already subscribed, and that they can ask Apple for a refund |
| 429 | — | Rate limited | Retry later |
| 502 | `APPLE_IAP_UPSTREAM` | Apple couldn't be reached | Retry later; don't finish the transaction |
| 503 | `APPLE_IAP_UNAVAILABLE` | App Store purchases aren't set up on this server | Hide the purchase button |

---

## Subscription fields

From `GET /api/v1/user/subscription` and the verify response. These are the fields that matter for iOS:

| Field | Values | Use |
| --- | --- | --- |
| `tier` | `plus` \| `free` | Whether they have Plus right now |
| `status` | `trialing`, `active`, `past_due`, `cancelled`, `expired` | `past_due` = Apple is having trouble charging them |
| `provider` | `stripe` \| `apple` \| `null` | Who bills them. `null` = never paid (trial or free) |
| `plan` | `monthly` \| `annual` \| `null` | Current plan |
| `pendingPlan` | `monthly` \| `annual` \| `null` | A plan change that takes effect at `currentPeriodEnd` |
| `currentPeriodEnd` | date | Paid until this date |
| `cancelAtPeriodEnd` | boolean | `true` = auto-renew is off; they keep Plus until `currentPeriodEnd` |
| `appleIapAvailable` | boolean | `false` = hide the App Store purchase button |
| `appleAppAccountToken` | UUID | Pass as `appAccountToken` when starting a purchase |

---

## UI rules based on `provider`

- **`provider: "apple"`:** hide our Cancel, Change plan and Reactivate buttons. Those endpoints return `409 MANAGED_BY_APPLE` for Apple subscribers. Show a "Manage subscription" link to `https://apps.apple.com/account/subscriptions` instead.
- **`provider: "stripe"` and `tier: "plus"`:** don't offer an App Store purchase. They already pay on the website, and buying again would bill them twice.
- **`provider: null`, or `tier: "free"`:** show the App Store purchase as normal.
- **Account deletion with `provider: "apple"`:** before deleting, tell the user to cancel in iPhone Settings → their name → Subscriptions. The backend can't cancel an App Store subscription, so Apple would keep charging them.

---

## Testing

- Sandbox and TestFlight purchases work against both staging and production. App Review also uses sandbox.
- Sandbox subscriptions renew every few minutes. Each renewal reaches the backend through Apple's notifications.

---

## What the backend needs from you

| Value | Where to find it |
| --- | --- |
| Bundle ID | Xcode → target → General |
| Monthly Plus product ID | App Store Connect → the app → Subscriptions |
| Annual Plus product ID | App Store Connect → the app → Subscriptions |
| Which purchase package you use | e.g. react-native-iap, expo-iap, RevenueCat. **If it's RevenueCat, tell us before building:** the integration would be different |

If you manage App Store Connect, the backend also needs:
- An **In-App Purchase** key (Users and Access → Integrations → In-App Purchase): its Issuer ID, its Key ID and the `.p8` file. Send these privately.
- **App Store Server Notifications V2** turned on, with both the Production and Sandbox URLs set to `https://<api host>/api/v1/user/subscription/apple/notifications`.
