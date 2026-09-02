# Switching on weight-based shipping

Everything for weight-banded shipping is merged and inert. This is what turning
it on involves, and what to watch afterwards.

## Before anything

**The stopgap only helps if it reaches production.** `SHIPPING_RATES` is set
explicitly in the Render environment, so the corrected defaults in
`.env.example` change nothing until that variable is updated. Until then, every
non-European order is still being sold postage below cost. Copy in:

```
SHIPPING_RATES=GB:349,IE:1099,EU:1499,US:1199,CA:1199,AU:1099,NZ:1199,GH:3399,NG:2399,KE:2699,ZA:2499,JM:3899,ROW:2499
SHIPPING_FREE_THRESHOLD_COUNTRIES=GB
```

## Turning the rate table on

1. **Deploy.** `npm run db:init` runs the migration and the seed on every
   deploy, so the rates land on their own. Confirm with
   `SELECT count(*) FROM shipping_rates` — expect 4,051.
2. **Staging first.** Set `SHIPPING_USE_RATE_TABLE=true` there and price a few
   real baskets through `POST /api/v1/cart/shipping-options`. Ghana at 400g
   should come back £9.15 untracked and £33.22 tracked.
3. **Decide the margin.** `SHIPPING_MARKUP_PERCENT` defaults to 0, meaning we
   charge exactly what Gardners charge us and make nothing on delivery. That is
   a launch position, not a decision — the books currently carry the margin.
4. **Production.** Set `SHIPPING_USE_RATE_TABLE=true`. Everything falls back to
   the flat table the moment it is unset, and orders already placed are
   unaffected either way.

## Watch for

- `npm run shipping:margin` — what we charged against what it cost, worst
  orders first. Run it a week after switching on, and after any rate change.
- Orders with `shipping_weight_estimated = true`. These were priced from an
  assumed book weight and are the most likely to disagree with an invoice.
- `SHIPPING_SERVICE_UNAVAILABLE` 400s. A client sending a service code the
  destination does not support usually means the cart and checkout disagree
  about the destination.
- `COUNTRY_NOT_SUPPORTED` 409s at checkout. With the rate table on, this now
  also catches destinations we can address but have no rate for.

## Known gaps

**Five countries have no published rate anywhere.** Ethiopia, Liberia, Rwanda,
Sierra Leone and Senegal are in neither the tracked nor the untracked sheet.
With the rate table on, checkout to those refuses with `COUNTRY_NOT_SUPPORTED`
instead of quoting a fallback. That is correct — we could not ship them — but
it is a visible loss of five destinations, so it needs a decision before
switch-on: chase Gardners for a quote, or stop listing them.

**Three are untracked-only.** Cameroon, Gambia and Tanzania have no tracked
price. They now get untracked automatically rather than a tracked service we
cannot price.

**DDP is not implemented.** Gardners publish duty-paid prices for 30 EU
countries which are cheaper than what we use and spare the buyer a customs
bill, but their service-code table has no code for it. We would be able to
price a DDP order and then have no way to submit one.

## Ask Gardners

Three questions, all blocking something real:

1. **What service code submits a DDP order?** The I12 table documents 001, 002,
   010, 011 and 015 only.
2. **How is a multi-book order boxed?** Rates are "per box, not per
   consignment", and we currently quote every basket as a single parcel. If
   they split at a known weight, we should quote that way.
3. **Rates for the five missing countries.** Or confirmation that they cannot
   be served at all.

Worth asking for the `I12d FTP Country List.txt` at the same time — the country
names we send are still mostly unverified guesses, and an unrecognised one is
manually reviewed on their side.
