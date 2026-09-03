# Orders remember how they were meant to ship

**Date:** 2026-09-02

## What changed

Three new columns on `orders`:

| column                      | notes                                                     |
|-----------------------------|-----------------------------------------------------------|
| `shipping_service_code`     | the Gardners service the order was priced for and must ship by |
| `shipping_weight_g`         | despatch weight the rate band was chosen from              |
| `shipping_weight_estimated` | true when a book's weight had to be assumed                |

`shipping_rule` also widened from 20 to 40 characters, because it now holds
`011:GH:500g` rather than `ROW`.

Fulfilment reads `shipping_service_code` and sends it to Gardners instead of
deriving a service from the destination country. The Stripe payment page names
the service too, rather than showing a generic "Delivery" line.

## Why snapshot it

The buyer chose and paid for a specific service. Re-deriving one at fulfilment
means a later change to how we pick a default would silently ship an old order
differently from how it was sold — a promise broken after the money moved.

It also makes reconciliation possible. When Gardners' postage invoice disagrees
with what we charged, the order row now says which service, which weight, and
whether that weight was a guess. `shipping_weight_estimated` is the first thing
to check.

## Backwards compatibility

All three are nullable or defaulted. Orders placed before this change, and any
order priced from the flat rate table, have no service code and fall back to
the old country rule — UK gets `001`, everywhere else `011`. Nothing about
existing orders changes.

## Verified

Migration applied to the development database. Typechecks and the suite passes.
