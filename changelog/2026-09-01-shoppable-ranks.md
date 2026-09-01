# `shoppable=true` ranks the catalogue instead of filtering it

## What changed

`GET /books?shoppable=true` no longer removes anything. It orders the page in
three bands:

1. **In stock** — an ISBN13, a live Gardners price, no unsuppliable report
   code, and `stock_qty > 0`.
2. **Orderable but unstocked** — the same supply test, no shelf. This is where
   GXC (extended catalogue) and M/D (print on demand) live: never stocked, always
   orderable, longer lead time.
3. **Unsellable** — no ISBN13, no live price, or an unsuppliable report code.

Every row now carries `shoppable: true|false`. Sellable rows keep `inStock` and
the live price fields; unsellable rows carry none of them.

`priceMin`/`priceMax` are unchanged and still filter.

## Why

The shop wanted its dead stock at the bottom of the list rather than missing
from it. A filter that changes the size of the catalogue with a query parameter
is also a filter a client cannot page through consistently — `shoppable=true`
and `shoppable=false` now return the same books in a different order.

## Non-obvious decisions

**The band is a predicate, not an `ORDER BY` key.** The obvious implementation
is a `CASE` in the sort, and it is the wrong one: the band is a correlated
subquery over `gardners_stock`, so as a sort key it has to be evaluated for
every candidate row before `LIMIT` applies, and it destroys the index-ordered
plan every list path here depends on — the same shape as the title-sort
regression documented on `buildFastTitlePrefixOrderBy` (70s+ measured), and the
reason `buildSortOrderBy` still refuses to offer a price sort. As a predicate it
is the shape `shoppable=true` has always used, backed by
`idx_gardners_stock_shoppable`. `list()` runs one band at a time and maps the
page offset onto them (`planShopBands`), so each band keeps whatever plan and
ordering it already had. Measured on the dev catalogue (83,688 books): page one
is 0.06ms / 4.2ms / 0.4ms for bands 0/1/2, all index-ordered, no sorts.

**Three bands, not two.** Two would leave out-of-stock titles mixed in among
the buyable ones. A finer split would be ordering on numbers the hourly feed
moves, which reshuffles the catalogue under a paginating client for no gain.

**Band 2 is the complement of the *supply* test, not the stock test.** It must
not mention `stock_qty` at all — an unstocked-but-orderable book is band 1, and
a band 2 that tested stock would claim it too, putting one book in two bands and
double-counting it across a page boundary. `shoppable.test.ts` asserts the
partition; it was also checked against the dev database, where the three bands
sum to exactly the catalogue.

**Unsellable rows carry no price and no stock badge.** An unsuppliable report
code does not erase the supplier price behind it, and some of those books are
even in stock — but a price on a row with no Add button reads as an offer, and a
stock badge there is a fact the caller cannot act on. The batched price and
stock lookups now skip those ISBNs entirely.

**The discovery feeds still filter.** `buildShoppableCondition` survives for
them: a feed is a handful of tiles that all render an Add button, with no
"further down the list" for an unsellable book to sink to. Both are defined
against the same supply test, so they cannot disagree about what sellable means.

**Deep pages inside a band cost more than the old single filter.** Measured at
offset 10,000: 54ms in band 0, 541ms in band 1, against 24ms for the old
combined filter. That is the price of the narrower predicate, it is offset
pagination rather than the ranking, and it is far past where any shopper goes —
page one is faster than it was.

## Migration

`0052_shop_band_stock_index.sql` adds `idx_gardners_stock_shoppable_stock`: the
existing shoppable predicate with `stock_qty` INCLUDEd, so the in-stock split
stays index-only instead of taking a heap fetch per candidate row. Written by
hand because drizzle-kit cannot express `INCLUDE` — changing the predicate on
`idx_gardners_stock_shoppable` without changing this migration leaves the two
disagreeing and the band query silently falls back to the heap.

## Caches

`books:list:v6` → `v7` and `books:count:v5` → `v6`. A v6 page holds the old
filtered rows with no `shoppable` field on them; a v5 total counts the sellable
slice rather than the whole catalogue, and the band ladder pages by offset, so a
total that stops short strands the tail.

## Client impact

A caller that relied on `shoppable=true` to exclude unbuyable books has to read
`shoppable` per row now — the unsellable band is still in the response, at the
end. `total` on a shoppable request is the whole filtered catalogue, so a
listing that wants only the sellable part should stop at the first
`shoppable: false` rather than paginate to `total`.
