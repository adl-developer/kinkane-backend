# Working out what a basket weighs

**Date:** 2026-09-02

## What changed

A new `measureParcel()` turns a basket into the three facts the rate table
needs: how many grams it weighs, whether it fits Royal Mail's large-letter
envelope, and whether any of it had to be estimated.

Book measurements now ride along on the availability check that every pricing
path already runs, so this costs no extra query — `BuyableBook` gained
`weightGr`, `heightMm`, `widthMm`, `thicknessMm` and `productForm`.

Still nothing quoting from it. Next change wires it to the rates.

## Coverage

Measured against the development catalogue:

- Weight is present on 87.5% of books overall, and **97.9% of books actually in
  stock** — GARDBIB carries a weight tag that ONIX often does not.
- Thickness is present on 79%.
- Of books with complete dimensions, 62% fit the large-letter envelope.

## Non-obvious decisions

**Every unknown resolves to the expensive answer.** The two failure directions
are not symmetric: under-estimating means paying the difference on every order
that hits the same case, while over-estimating costs a little margin. So a
missing dimension means "not a large letter", and a missing weight falls back
to the 90th percentile for that book's format — 800g for a paperback, 1300g for
a hardback — rather than the median.

**Page count was tried as a predictor and mostly rejected.** It works for
paperbacks (r² 0.55, about 1.25g per page) but explains almost nothing for
hardbacks (r² 0.11), where the boards dominate. A rule that works for one
format and not the other is worse than one conservative constant per format.

**Packaging counts.** Gardners weigh the despatched parcel, not the book, so
40g is added for a card wrap and 120g for a box. Without this, a 740g book
would be quoted as a large letter and invoiced as a parcel. It is deliberately
generous.

**A weight of zero is treated as missing.** A book recorded as weighing nothing
is a data error, not a free postage opportunity.

**One box, always.** Gardners price "per box, not per consignment" and split
large orders at their own discretion, which we cannot predict — so a heavy
basket is quoted as one heavy parcel. That over-quotes a split order rather
than under-quoting it, and the alternative is inventing a packing algorithm
whose output we could not check. Worth raising with Gardners.

## Verified

15 unit tests, including the boundary cases: packaging pushing a book over the
750g limit, thickness stacking across copies and lines, a book catalogued
landscape still fitting, and every missing-measurement path resolving upwards.
