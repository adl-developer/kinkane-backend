# App Store: accept the Founding Member products

## What changed

The iOS app sells four Kinkané Plus products. Until now the server only knew two of them: one monthly and one annual. Buying either of the other two went through on the App Store, but the server didn't recognise the product, so the buyer never got Plus.

The server now accepts all four:

| App Store Product ID | Plan | Founding Member |
|---|---|---|
| `003` | monthly | no |
| `002` | annual | no |
| `005` ("Early Monthly") | monthly | yes |
| `004` ("Early Annual") | annual | yes |

Two new settings name the founding products, matching the founding Stripe prices:

- `APPLE_PRODUCT_PLUS_MONTHLY_FOUNDING`
- `APPLE_PRODUCT_PLUS_ANNUAL_FOUNDING`

Both are optional. When they're unset, only the two standard products unlock Plus, as before.

The client team also confirmed that the bundle ID is `com.kinkaneapp.kinkane`, not `com.kinkane.app`. `.env.example` now uses the real IDs.

## Founding Member flag

- **A founding product bought while the offer is open** marks the subscription as a founding member (`isFoundingMember: true`). "Open" means before `FOUNDING_OFFER_ENDS_AT`, the same window Stripe checkout uses, judged by when the purchase was made. A founding product still on sale after the window grants Plus but not founding status. If `FOUNDING_OFFER_ENDS_AT` is unset, no App Store purchase gets founding status, the same as on the web.
- **The flag stays while that purchase keeps running**, including after it renews onto a standard product. This matches Stripe, where a founding member keeps the flag after the price rolls over.
- **The flag is lost when the subscription ends.** Resubscribing later, even under the same App Store purchase chain, starts again without it, as the API docs describe.
- **A flag from a different purchase is never carried across.** That includes a Stripe founding membership. This keeps the existing rule.
- **The confirmation email** now includes the Founding Member line for a founding buyer. Until now App Store buyers always got the standard email.
- **Moving from a founding product to its standard equivalent** is now recorded as a `plan_changed` event, naming both products. The plan stays the same, so before this the move left no trace. It still doesn't show as a pending change on the account screen, because `pendingPlan` can only express monthly or annual, not a price.

## Settings safeguards

- **A blank founding variable now counts as unset.** For example, `APPLE_PRODUCT_PLUS_MONTHLY_FOUNDING=` with no value used to stop the server from starting.
- **The server refuses to start if two `APPLE_PRODUCT_PLUS_*` values are the same.** A founding ID copied from a standard one would have marked every standard buyer a founding member. An ID listed under both plans would have recorded annual buyers as monthly.
- **The four products are now held in one table** in config (`apple.productsById`), keyed by Product ID, instead of being compared one variable at a time.

## Left as it was

- The App Store Connect key (`APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY`) is still required. Every purchase is confirmed with Apple using it, so without it the Apple routes still answer 503.
- The server can stop granting founding *status* after the window, but it can't stop Apple *selling* a founding product. Closing the offer on iOS still means removing the products from sale in App Store Connect, or hiding them in the app.

## Verification

New unit tests check that:

- a founding product unlocks Plus on the right plan, sets the flag and sends the founding email;
- a founding product bought after the window gets no founding status;
- a renewal after the window keeps the flag for a purchase made inside it;
- an ended chain that is resubscribed loses the flag;
- a flag from a different App Store chain is not carried over;
- a notification for a founding purchase sets the flag;
- the move from founding to standard pricing records `plan_changed`, and an unchanged product records nothing;
- all four product IDs map to the right plan and founding status;
- blank founding values let the server start, and duplicate IDs stop it.

Temporarily undoing the email, window and resubscribe fixes made the matching tests fail. The full unit suite passes (1524 tests), and the type check is clean.
