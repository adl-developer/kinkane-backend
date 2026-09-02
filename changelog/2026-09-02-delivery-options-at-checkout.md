# Letting the buyer choose their delivery

**Date:** 2026-09-02

## What changed

A new endpoint returns the delivery options for a basket to a country, priced,
and checkout now accepts the one the buyer picked.

```
POST /api/v1/cart/shipping-options
{ "countryCode": "GH", "lines": [{ "bookId": 48213, "quantity": 1 }] }

{
  "currency": "GBP",
  "options": [
    { "serviceCode": "010", "label": "Standard international", "tracked": false,
      "estimatedDaysMin": 7, "estimatedDaysMax": 10,
      "priceMinor": 915, "priceGbpPence": 915, "recommended": true },
    { "serviceCode": "011", "label": "Tracked international", "tracked": true,
      "estimatedDaysMin": 7, "estimatedDaysMax": 10,
      "priceMinor": 3322, "priceGbpPence": 3322, "recommended": false }
  ],
  "weightEstimated": false,
  "unavailableReason": null
}
```

`POST /api/v1/cart/checkout` gained an optional `shippingServiceCode`. Pass the
code the buyer chose; the server re-prices from it and never trusts a price
sent by a client.

## Why

Those two numbers are the whole point. We sent every overseas order tracked,
which on a single paperback to Ghana is a £24 upgrade nobody was asked about
and — until the rate table landed — nobody could see.

## For the client apps

The cart's `estimatedShippingMinor` now quotes the **cheapest** option rather
than a flat regional figure, which is the same one this endpoint marks
`recommended`. Quoting the dearest in the cart and the cheapest at checkout
would read as a price rise on the way to paying.

Two states worth handling:

- **`options: []` with `unavailableReason`.** Either `country_not_supported`
  (we cannot address a parcel there at all) or `no_service` (we can, but
  nothing available can carry this basket — usually too heavy for the only
  service that serves it). Show it in the cart. Reaching checkout and being
  refused is the experience this replaces.
- **`weightEstimated: true`.** A book in the basket had no weight recorded and
  one was assumed. The price is still binding. The flag is for support, not for
  the buyer.

## Non-obvious decisions

**Omitting the code gets the cheapest service, not the previous default.** A
client that has not yet built a chooser must not silently upgrade buyers onto
tracked delivery — that is the behaviour being fixed, and defaulting to it
would preserve it for every unupdated client.

**A code that does not serve the destination is a 400, not a downgrade.** The
buyer is looking at a price for a service they picked. Quietly charging them
for a different one is the worst available outcome, so
`SHIPPING_SERVICE_UNAVAILABLE` sends them back to re-choose.

**The country is required and never inferred from the caller's IP.** Quoting
one country and charging for another is the failure this endpoint exists to
prevent.

**Options are priced against what can actually be bought.** Out-of-stock lines
are excluded from the parcel — weighing them in would quote a heavier band than
the one that ships.

**BFPO is not offered.** It needs the BFPO number inside the address and is a
different address shape entirely, so it is a feature rather than a branch — the
same reasoning that already keeps it out of the fulfilment path.

## Left out of scope

The order still records only the price, not which service produced it, and
fulfilment still derives the service code from the country. That is the next
change.

## Verified

Typechecks and the full suite passes. Behaviour is exercised by the pricing and
rate-card tests; the endpoint itself is thin over
`shippingOptionsService.list`, which they cover.
