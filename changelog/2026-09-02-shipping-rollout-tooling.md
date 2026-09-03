# Seeing whether delivery pays for itself

**Date:** 2026-09-02

## What changed

`npm run shipping:margin` reports what we charged for postage against what it
cost, for paid orders in a date range, worst offenders first.

```
npm run shipping:margin              # last 90 days
npm run shipping:margin -- --days 30
```

It recomputes each order's cost from the rate table using the service and
weight recorded on the order, so it is a check on our own pricing rather than a
reconciliation against a Gardners invoice. Once invoices are ingested,
comparing those to `shipping_gbp_pence` is the stronger version of this.

Orders placed before delivery options existed carry no service code or weight,
so there is nothing to recompute from. They are counted and skipped rather than
guessed at.

Also adds `docs/shipping-rates-rollout.md`: what switching the rate table on
involves, what to watch afterwards, the known coverage gaps, and the three
questions outstanding with Gardners.

## Also in this change

20 tests for the delivery-options service — which services a destination is
offered, that the recommended one is the cheapest rather than the fastest, that
a basket too heavy for untracked airmail loses that option and keeps the rest,
that BFPO is never offered, and that the default with no client choice is the
cheap service rather than the dear one.

## Verified

Run against the development database: the single existing paid order predates
the new columns and is correctly reported as skipped rather than compared.
