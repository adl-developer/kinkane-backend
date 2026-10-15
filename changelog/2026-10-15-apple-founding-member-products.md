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

- **Buying a founding product** marks the subscription as a founding member (`isFoundingMember: true`). Until now an App Store subscription was always `false`.
- **The flag stays with that purchase**, including after it renews onto a standard product. This matches Stripe, where a founding member keeps the flag after the price rolls over to the standard one.
- **A flag from a different purchase is never carried across.** That includes a Stripe founding membership: someone who was a founding member on the web and later subscribes through the App Store at the standard price is not marked as one. This keeps the existing rule.

## Left as it was

- The App Store Connect key (`APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY`) is still required. Every purchase is confirmed with Apple using it, so without it the Apple routes still answer 503.
- Nothing on the server stops a new App Store buyer choosing a founding product after `FOUNDING_OFFER_ENDS_AT`. Apple sells whatever the app shows, so closing the offer on iOS means removing the products from sale in App Store Connect, or hiding them in the app.

## Verification

New unit tests check that:

- a founding product unlocks Plus on the right plan and sets the flag;
- the flag survives a renewal onto the standard product in the same purchase;
- a standard product doesn't set the flag;
- all four product IDs map to the right plan, and an unknown product maps to none.

The existing test that a Stripe founding flag is never carried onto an App Store subscription still passes. The full unit suite passes (1512 tests), and the type check is clean.
