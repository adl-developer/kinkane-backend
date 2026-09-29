# Shop hides books you can't buy, and lists market-restricted titles last

**Date:** 2026-09-29

## What changed

`GET /books?shoppable=true` (v1 and v2) is a filter again. Books a customer
cannot buy are no longer listed at the end of the results — they are not
listed at all. That covers any book with:

- no ISBN13,
- no live Gardners price, or
- an unsuppliable Gardners report code (`NYP`, `OSI`, `O/P`, `CNC`, `R/P`,
  `POS`, `REF`).

What is left is ordered in four groups:

| # | Group                         | Meaning                                                        |
|---|-------------------------------|----------------------------------------------------------------|
| 1 | In stock                      | Gardners has copies; not restricted in your country            |
| 2 | In stock, restricted          | Gardners has copies; restricted in your country                |
| 3 | To order                      | No copies on the shelf (print on demand, extended catalogue, or out of stock today); not restricted |
| 4 | To order, restricted          | As above, restricted in your country                           |

In-stock books always come before to-order books. Within each of those,
unrestricted titles come before restricted ones.

With `shoppable=false` (the default) nothing changes: every book comes
through, in its normal order.

`total` now counts only the sellable books when `shoppable=true`. The
`shoppable` field is still on every row, and is now always `true`.

## Why

The shop was showing books with no price and no way to buy them at the end of
the listing. Browsing into that tail was a dead end, and the total promised
pages that were mostly unsellable.

## Market restrictions by country

"Restricted" is judged against the customer's country, not against any market
at all. A book that only can't be sold in the USA stays at the top for a
customer in Ghana. The country comes from the request, the same way the cart
already works it out: a trusted CDN geo header (`GEO_COUNTRY_HEADER`), then a
MaxMind lookup (`MAXMIND_DB_PATH`). If neither gives an answer, any restriction
counts, which was the earlier behaviour.

The rule is the one add-to-cart already used:

- An `N` row naming one of the customer's regions means the book can't be sold
  there.
- `Y` rows that name none of the customer's regions mean the book is sold only
  elsewhere, so it can't be sold there either.
- Books with no rows are unrestricted everywhere.

The country → Gardners region mapping this relies on, and what it changes at
add-to-cart, is described in `2026-09-29-books-restricted-elsewhere-can-be-bought.md`.

## Other decisions worth knowing

- **Out-of-stock books stay in.** Stock changes every hour. Removing
  out-of-stock books would make titles disappear and reappear while someone is
  paging through the shop. They stay in, badged `inStock: false`.
- **Restricted books are ranked lower, not removed.** The browsing country is
  only a guess from the IP address. Someone in the UK may be ordering to an
  address in Ghana.
- **The restriction check is a per-row lookup, not a join.** Written as a
  plain `NOT EXISTS`, Postgres hashed the entire 875k-row restrictions table
  and sorted the result on every page load (34 ms → 714 ms for page 1 locally).
  Written as `(SELECT EXISTS (...))`, the planner can't turn it into a join,
  so it stays one index lookup per book: 14 ms.

## Operational notes

- Cache keys were bumped (`books:list:v10`, `books:count:v7`,
  `books:shopband:v2`), so old cached pages are not served after deploy.
- Shop pages and band counts are cached per set of regions, so countries with
  the same regions (most of Africa, for example) share entries. The total is
  shared by every country, since it doesn't depend on restrictions.
- **The country only resolves if `GEO_COUNTRY_HEADER` or `MAXMIND_DB_PATH` is
  set.** Without either, every shopper gets the "any restriction counts"
  ranking.
- Deep shop pages now count three groups instead of two to work out where
  each page starts. The first page never counts anything. The counts are
  cached like before.

## Out of scope

- The discovery and recommendation feeds already exclude unsellable books,
  and are unchanged.
- Out-of-stock titles with no report code still appear in the "to order"
  groups, even though add-to-cart rejects them. Their `availableQuantity` is
  `0`, which the app can use to disable the button.

## How it was verified

- Unit tests for the band SQL, the country-aware restriction SQL, the page
  planner, and the filter being on every query (rows, total, band counts) and
  absent when `shoppable=false`. Full suite: 1119 passing.
- Against the local database, the SQL restriction check was compared with
  add-to-cart's own rule for all 22,571 restricted books in 12 countries (GH,
  NG, GB, US, FR, IE, ZA, JP, IN, BR, AU, KE). There were zero disagreements.
  Books counted as restricted: Ghana 84, UK 122, France 27, USA 22,213.
- Against the local database (83,688 books): the shoppable listing ends at
  exactly 66,044 rows, the sum of the four groups. The in-stock → to-order
  boundary falls at row 34,314. The unrestricted → restricted boundary inside
  the in-stock group falls at row 20,778. A search for "harry" returns 136
  books with `shoppable=true` and 160 without. Page 1 cold: 9–90 ms depending
  on country. Deep pages take 1–2 s cold, then come from the cache.
