# Shop search lists forthcoming books last

## What changed

`GET /books?q=…&shoppable=true` now includes titles Gardners reports as **NYP —
not yet published**, after every book that can be bought. Follows the typeahead
change from earlier the same day (`2026-11-25-search-forthcoming-books`), which
left the shop search still hiding them.

## API shape

Forthcoming rows come back with `shoppable: false` and no `inStock` or price
fields, which is the same shape the API already uses for any row that cannot be
bought. Clients that show an Add button only when `shoppable` is true need no
change. Adding one to the cart is still refused.

## How

- A fifth shop band, `FORTHCOMING`, sits after the four buyable bands.
  `UNSELLABLE` moves from 4 to 5. `isSellableBand` is false for both.
- A shoppable request with a `q` walks `SEARCH_SHOP_BAND_ORDER` (the four bands
  plus `FORTHCOMING`), and its filter lets `NYP` through. Browsing the shop with
  no `q` is unchanged.
- `planShopBands` takes the band order as an argument, defaulting to the old one.
- The cache keys moved to `books:list:v14` and `books:count:v9`, so cached
  pages and totals without these books aren't served.

## Left out

- Browsing the shop (`shoppable=true` without `q`), the feeds, "other editions"
  and checkout still exclude NYP.
- A sibling edition that is NYP still ranks as unsellable in the edition picker.
  The result is the same: `shoppable: false`, sorted last.
- No "forthcoming" field: clients can't yet tell NYP apart from other
  unbuyable rows.

## Performance

The forthcoming band is only fetched once the buyable bands run out for a
page. On prod (read-only, 2026-11-25), the band query for `ghan%` took 2 ms.
For `the%` it took 1.8 s warm (9 s cold), but a query that common only reaches
the band on its last pages. Paging past offset 0 now counts the fourth band too.
That count is capped like the others.

## Verified

- Unit tests for the band SQL, `isSellableBand`, the search band order, and
  planning a page into the last band. The full suite passes.
- On prod, read-only, the forthcoming band returns Ghananya Revisited.
