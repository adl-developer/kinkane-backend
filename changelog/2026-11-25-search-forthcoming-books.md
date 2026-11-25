# Search finds forthcoming books

## What changed

Book search (`GET /books/search`, the typeahead) now returns titles Gardners
reports as **NYP — not yet published**. Previously they were hidden along with
genuinely dead titles (out of print, cancelled and so on).

## Why

A reader searched for "Ghananya Revisited" (9781496249890, University of
Nebraska Press, due 2027-01-01) and got nothing. The book is in the catalogue
with a Gardners price, but its stock row carries report code `NYP`, which was in
the unsuppliable list that search shares with the shop. Someone typing an exact
title is looking for that book; telling them it doesn't exist is worse than
showing it and saying it isn't out yet.

## Scope

Only typeahead search changed. Still excluding NYP, unchanged:

- add-to-cart / checkout (`availabilityService`) — a forthcoming book cannot be
  bought, so the cart still refuses it;
- `GET /books?shoppable=true`, the shop listing;
- recommendation and browse feeds (in-stock only);
- a book page's "other editions" list, where every row is a buy link.

`buildShoppableCondition` gained an opt-in `includeForthcoming` flag rather than
`NYP` being removed from `UNSUPPLIABLE_REPORT_CODES`, which would have opened
all of the above.

The suggestions cache key moved to `v9` so cached empty results for such titles
are not served.

## Not done

- Search results carry no "forthcoming" marker; the product page is what the
  reader lands on. If the apps want a badge, that needs a field adding.
- Pre-orders are not supported.

## Notes

- On prod there were 69,735 priced NYP titles on 2026-11-25. All of them are now
  findable in search.
- With `NYP` no longer in the list, the query no longer matches the partial
  index `idx_gardners_stock_shoppable`'s predicate, so the planner probes
  `uq_gardners_stock_isbn13` instead. EXPLAIN ANALYZE on prod for a `the%`
  prefix took ~62 ms.

## Verified

- Unit test: the flag drops only `NYP` from the bound codes; the default still
  binds every code.
- `tsc --noEmit` clean; `shoppable` and `catalogue-filters` tests pass.
- A read-only query on prod with the new predicate returns Ghananya Revisited.
