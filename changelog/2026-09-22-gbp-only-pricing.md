# Prices are now shown and charged in GBP, exactly as Gardners supplies them

## What changed

The shop no longer converts currencies. Every price, sale price, discount,
shipping charge, tax line and order total is Gardners' own figure in pounds,
for every customer wherever they are, and Stripe charges in GBP.

Before, a customer's currency was picked from their country (US and unknown
countries got USD, the eurozone EUR, the UK GBP). Prices were converted with a
fixed exchange-rate table (`USD:1.27, EUR:1.17`) plus a 3% buffer and rounded
up. So a £16.99 book was shown to a US buyer as about $22.23.

## API shape

Nothing was added or removed from responses. Every `currency` field now says
`"GBP"`, and every `*Minor` amount is pence.

- The `currency` parameter (on `GET /books`, `/cart/price`, `/cart/checkout`,
  `GET /cart`) is still accepted but ignored, so older clients keep working.
  Sending `currency=USD` returns GBP.
- `priceMin` / `priceMax` on `GET /books` are now always in pounds.
- Orders still record `fx_rate`. It is now always `1`.

## Decisions worth knowing

- **Pinned in code, not just config.** Setting `DEFAULT_CURRENCY=GBP` would not
  have been enough: a client could still request USD, and an environment that
  still had the old variables set would quietly bring conversion back. GBP is
  now a constant (`SHOP_CURRENCY` in `services/commerce/pricing.ts`).
- **Other currencies fail loudly inside the server.** If code ever asks the
  pricing functions for a currency other than GBP, they throw instead of
  converting. From the outside that can't happen, because the requested
  currency is always resolved to GBP first.
- **Config removed.** `SUPPORTED_CURRENCIES`, `DEFAULT_CURRENCY`,
  `CURRENCY_BY_COUNTRY`, `FX_RATES_FROM_GBP` and `FX_BUFFER_PERCENT` are gone
  from the config schema and `.env.example`. They're harmless if still set on a
  deployed service, but can be deleted there.

## Out of scope

- Kinkané Plus subscription prices come from Stripe prices and were not touched.
- Existing orders placed in USD or EUR keep their original amounts and currency.
- The order table's currency columns were left as they are. They hold GBP and
  a rate of 1 from now on.
- `docs/ecommerce-plan.md` is a historical design document and still describes
  the old multi-currency plan.

## How it was verified

- Pricing tests were rewritten for the new rule: GBP whatever the requested
  currency or country, amounts passed through unchanged, other currencies
  refused, and a rate of 1 on the order quote. Full unit suite passes
  (940 tests).
- Checked live against a local copy of the catalogue: a £16.99 book priced for a
  US buyer asking for USD, a German buyer asking for EUR and a UK buyer all
  came back as `GBP` 1699, and `GET /books?shoppable=true&currency=USD` returned
  GBP prices.
- Endpoint contract suite: no endpoint returns a 5xx. The one failing check is
  the referral redirect following `APP_URL` to `localhost:3000`, which fails
  identically on `main` when nothing is running on that port.
