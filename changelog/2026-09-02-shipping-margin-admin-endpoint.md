# Postage margin, in the admin console

**Date:** 2026-09-02

## What changed

`GET /admin/console/shipping-margin` returns what we charged for delivery
against what it cost, for paid orders in a window. It is the same report the
terminal script produced, moved somewhere it can actually be read on a deployed
environment — there is no shell on the live server to run a script from.

```
GET /admin/console/shipping-margin?days=90&limit=20
```

The script still exists and is now a printer over the same service, so the two
cannot drift.

## Response

Amounts are GBP pence. This is the supplier-facing side of the money, so
nothing is converted into a customer currency.

`comparableOrders` plus `skippedOrders` is every paid order in the window.
Skipped ones were priced before delivery options existed, or their destination
has since lost its rate — no service code or weight, so nothing to recompute
from.

`caveats` is a list of plain-English notes to render alongside the figures.
Cost is recomputed from our own rate table rather than a real invoice, and UK
orders are costed at the parcel rate because the order does not record whether
it went as a large letter. An operator reading the numbers without those two
facts will over-read them.

## Two bugs this found

Both were caught by running the thing against a synthetic order rather than
trusting that it typechecked.

**Cost was being read from the retail table.** The report called
`quoteShipping`, which is gated behind `SHIPPING_USE_RATE_TABLE` — so with the
flag off it returned the flat *price* we charge, and the report compared a
price against another price. Worse, it would have included any configured
markup in "cost". Fixed by adding `quoteShippingCost`, which always prices from
the rate card and ignores both the feature flag and the free-shipping
threshold: what a parcel costs does not depend on what we chose to charge for
it. Anything customer-facing still goes through `quoteShipping`.

**Item counts were summed across every order at once.** The correlated
subquery `WHERE order_id = ${orders.id}` renders as `WHERE order_id = "id"`,
and since `order_items` has its own `id` column, Postgres bound both sides
inside the subquery. Every order got the same wrong count, which inflated the
fulfilment fee and overstated cost. Replaced with a grouped query.

Worth knowing generally: **Drizzle only qualifies column references inside a
raw `sql` fragment when the query has a join.** With a join it emits
`"book_promotions"."book_id" = "books"."id"`; without one it emits `"book_id" =
"id"`. The existing correlated subquery in `availability.service` is safe
because that query joins — verified by inserting a live promotion and
confirming the sale price applied — but a new one in a join-free query is not.

## Verified

Against a synthetic paid order created and then deleted, with the database
confirmed back to its original row counts: a 480g tracked Ghana parcel charged
£11.99 comes back as £33.22 cost and −£21.23 margin, and the fulfilment fee
moves correctly from £0.70 to £0.78 when the order carries two items. The
endpoint was exercised over HTTP: 401 unauthenticated, 400 on `days=0`, 200
with the expected body.
