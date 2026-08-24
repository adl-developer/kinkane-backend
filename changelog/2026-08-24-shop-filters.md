# Filtering the shop by ISBN, price and publication year

## What changed

The Filters panel in the web eCommerce designs asks for four things
`GET /books` could not do. It now takes:

- `isbn` — exact ISBN-13, hyphens and spaces stripped.
- `yearMin` / `yearMax` — publication year, inclusive at both ends.
- `priceMin` / `priceMax` — in **major units** of `currency` (`20` means $20),
  converted server-side to the GBP pence the catalogue stores.
- `sortBy=title|newest`, with the existing `sort` as its direction.

## Why

The panel is drawn and the client had nothing to call. Price is the interesting
one: it is the only filter whose value the customer types in one currency and
the database holds in another.

## Non-obvious decisions

**Price bounds ride inside the existing `shoppable` EXISTS** rather than adding
a second correlated subquery — the same index probe, one more comparison on a
row already fetched.

**Price bounds without `shoppable=true` are a 400.** The price lives on the
Gardners row that only the shoppable path consults. Ignoring the filter would
return an unfiltered page that looks filtered, which the client cannot detect.

**The price boundary is inclusive at both ends and approximate by up to a
penny.** The displayed price is converted out of GBP with a rounding buffer, so
the inverse cannot round-trip exactly. Erring inclusive shows a book a penny
outside the range rather than hiding one inside it.

**`toGbpPenceFromMinor` is documented as unusable for charging.** It exists only
to convert filter bounds. The forward conversion rounds up twice, so the inverse
is approximate — fine for a boundary, not for money someone pays.

**`sortBy` is ignored when `q` is present**, matching what `sort` already did. A
page *selected* by fuzzy relevance and then reordered by title is neither
ranking. This is called out in the route comment and the OpenAPI description,
because a silent no-op gets filed as a bug otherwise.

**Undated books drop out of a year-filtered result.** A book with no publication
date cannot be shown to satisfy a date range.

**`countCacheKey` needed no change.** It is derived by *removing* the
page-shaped fields rather than by listing the filters, precisely so a new filter
is counted correctly the moment it exists. Only `sortBy` was added to that
removal list, so sort directions keep sharing one cached total.

## Explicitly out of scope

**There is no price sort**, though the designs' Sort By dropdown implies one is
coming. Ordering on the supplier price means evaluating a correlated subquery
for every candidate row before the limit applies — the same shape as the
title-sort regression documented on `buildFastTitlePrefixOrderBy`, which
measured at 70s+ before its index existed. It needs an EXPLAIN against
production data, and probably a different query shape, before it ships.

**Author is not a separate filter.** The panel has an Author box; `q` already
matches author names, and a dedicated parameter would need its own ranking
story.

## Verification

`npx tsc --noEmit` clean. `src/__tests__/catalogue-filters.test.ts` asserts the
generated SQL — one EXISTS rather than two, both bounds parameterised, a zero
lower bound treated as a real bound (the filter UI's default), and the
unbounded shape byte-identical to before so existing cache entries still hit —
plus the currency conversion, including that it accounts for the FX buffer and
round-trips `toPresentment` to within a penny.

Not verified against a live database: the filters are asserted at the SQL level
only.
