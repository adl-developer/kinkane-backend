# Free postage still ships by what the buyer chose

**Date:** 2026-09-02

## What changed

A free-shipping order now keeps the delivery service and parcel weight it was
quoted for, instead of losing them along with the price.

## The bug

`quoteShipping` checked the free-shipping threshold before looking anything up
in the rate table, and returned early with just `{ gbpPence: 0, rule:
'FREE_THRESHOLD' }`. No service code, no weight.

That has consequences well past the missing fields. `shipping_service_code`
lands null on the order, and fulfilment falls back to the country default —
which for every overseas destination is the **tracked** service. So a £40
basket to Ghana would collect nothing for postage and be invoiced £32.52 for a
service the buyer never chose. The same orders were also invisible to the
margin report, because it skips rows with no recorded weight, which meant the
orders most likely to be underwater were the ones it could not see.

Found in review before the rate table was switched on anywhere, so no order was
ever priced this way.

## The fix

The threshold is applied *after* the band lookup, zeroing the price while
keeping everything else. The audit string records both facts —
`010:GH:500g:free` — so the band the order would have been charged at stays
legible. The flat-table path is untouched and still returns
`rule: 'FREE_THRESHOLD'`.

## Still a decision, not a bug

An order over the threshold gets every service free, including the tracked
upgrade. Nothing is mis-shipped, but a free order can be a tracked one. The
default of UK-only free shipping keeps that to the gap between second class and
next-day; widening it needs a rule that only the cheapest service goes free.
Written up in `docs/shipping-rates-rollout.md`.

## Verified

Three new cases: the service and weight surviving a free quote, the threshold
still charging below it, and the country list still honoured under the rate
table.
