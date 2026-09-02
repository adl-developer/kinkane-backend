# Quoting shipping from real weights and real rates

**Date:** 2026-09-02

## What changed

`quoteShipping()` can now price an order from the rate table instead of the
flat per-country map: it picks the cheapest weight band the parcel fits for the
chosen service, then builds the figure up from costs we can point at on an
invoice.

```
postage for the band
+ Gardners' fulfilment fee (£0.70 first item, £0.08 each for the next three)
+ £3 EU customs surcharge, inside the EU only
+ configured margin (default 0%)
```

Off by default. `SHIPPING_USE_RATE_TABLE=true` switches it on; anything else
keeps the flat table, unchanged. No caller passes the new arguments yet, so
this change moves no money on its own.

## How the pieces fit

- `shipping-rates.service.ts` reads the table once and caches the result for
  ten minutes, then hands pricing a plain in-memory rate card.
- `pricing.ts` stays a pure function of its arguments. It takes the card as a
  parameter rather than fetching one, which is the whole reason the loader is a
  separate file — every branch below is testable without a database.
- `quoteOrder()` passes the new inputs straight through and now also reports
  the service code, despatch weight, and whether that weight was estimated.

## Non-obvious decisions

**Rules read like `011:GH:500g`.** The `shipping_rule` stored on an order used
to be a bucket name (`ROW`). It is now service, destination and band, so "why
was this charged £33?" is answerable from the order row without re-deriving
anything.

**A destination we cannot price is refused, not guessed.** Two refusals: no
rate for that service to that country, and a parcel heavier than every band.
Quoting the top band for something above it undercharges by an unbounded
amount, and Ethiopia has no published rate at all — a fallback would mean
accepting an order we cannot ship.

**Peak season is computed in UTC.** The window wraps the new year (17 November
to 6 January), so a naive `start <= today <= end` is wrong for the January half
of it. It is also evaluated in UTC rather than local time: the parcel is
despatched from Eastbourne, and which side of a date boundary that falls on
must not depend on the timezone the server happens to run in.

**The feature flag is a string comparison, not `z.coerce.boolean()`.** Zod's
coercion follows JavaScript truthiness, under which the string `"false"` is
`true` — which for this variable would mean switching the whole quote path on
while the environment says it is off. The repo's existing `VAT_PRICES_INCLUDE_TAX`
uses the same string transform for the same reason.

**The rate card cache shares one query between concurrent callers.** Without
that, a cold cache under load means every simultaneous checkout issues the same
four-thousand-row read.

## Left out of scope

Nothing calls this yet — the cart, checkout and fulfilment paths still use the
flat table. Choosing between tracked and untracked at checkout comes next.

## Verified

21 new tests covering band selection and its inclusive upper bound, the
fulfilment fee capping at four items, the EU surcharge applying only inside the
EU, markup, UK large-letter versus parcel pricing and the fallback for
destinations that have no large-letter table, both peak-season boundaries at
each end of the year, both refusal paths, and the flat-table fallback when the
flag is off or a caller passes no parcel.
