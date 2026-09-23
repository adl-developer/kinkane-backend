# Every book now says how many copies can be bought

## What changed

Every book response now carries `availableQuantity`, a whole number giving how
many copies one customer can buy right now:

- `GET /books` (v1 and v2), on every row, whether or not `shoppable=true` is sent
- `GET /books/:id`
- every discovery feed: trending, personalized, similar, "liked by readers
  like you" and bestsellers

Before this, only the cart (`POST /cart/price`) said how many copies could
actually ship. A product page or listing had `inStock` at best, so the app had
no way to limit a quantity stepper or show "only 2 left" before the customer
tried to add to the basket.

## What the number means

| Book | `availableQuantity` |
|---|---|
| In stock with Gardners | Its stock, capped at the per-line maximum (`CART_MAX_QUANTITY_PER_LINE`, 10 by default) |
| Supplied to order (report code `GXC` or `M/D`) | The per-line maximum |
| Out of stock, no live price, unsuppliable report code, no ISBN, or no Gardners row at all | `0` |

These are the same rules add-to-cart already enforces, so a stepper built on
this number never offers a quantity the basket then refuses. The rules live in
one function (`availableQuantityFor` in `lib/shoppable.ts`) next to the report
code lists the cart gate shares.

## Decisions worth knowing

- **Always capped, never raw stock.** `inStockByIsbns` deliberately returned a
  boolean because Gardners' wholesale stock levels are not ours to publish. Capping
  at the per-line maximum keeps to that: the most this can reveal is "fewer than
  10 left".
- **Always present, never missing.** A book that cannot be bought gets `0` rather
  than no field, so the client never has to guess what a missing value means.
  This differs from `inStock` and the price fields, which only appear on sellable
  `shoppable=true` rows.
- **Added after the cache, not stored in it.** The book page is cached for an
  hour and listing rows for a shorter time, but stock changes every hour. The
  quantity is looked up on every request with one batched query per page,
  after the cached payload is read.
- **Rights restrictions are not applied.** They depend on the delivery country,
  which a catalogue request doesn't have. Add-to-cart still enforces them.

## Out of scope

- Saved books and the cart keep their own existing fields (`orderableQuantity`
  / `availableQuantity` on cart lines); they were not changed.
- Typeahead suggestions (`GET /books/search`) are not a shop surface and carry no
  stock fields.

## How it was verified

- Unit tests for `availableQuantityFor` covering stocked, capped, zero stock,
  supply-to-order, every unsuppliable code, missing price and missing row.
- Full test suite passes (950 tests).
- Checked live against a local copy of the catalogue: stock 3 → 3, stock 1000 →
  10, `GXC` with stock 0 → 10, stock 0 → 0, `NYP` with stock 5 → 0. The field is
  present on a cached `GET /books/:id` read, on `GET /books` with and without
  `shoppable`, on a search, and on the similar-books feed.
