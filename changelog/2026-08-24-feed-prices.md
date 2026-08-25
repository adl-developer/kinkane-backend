# Discovery feeds carry a live price

## What changed

`GET /explore/trending`, `GET /explore/personalized`, `GET /books/:id/similar`
and `GET /books/recommendations` now return `unitPriceMinor`, `compareAtMinor`,
`currency` and `inStock` when passed `shoppable=true` — the same fields
`GET /books` returns, from the same source.

## Why

`shop-integration.md` has always told clients to pass `shoppable=true` "from any
surface that renders an Add button", and named these four feeds. They filtered
correctly but returned no price, so every carousel with an Add button had to
either fetch the same books again through `GET /books` or show a title with no
price. The PDP's "You may also like" and the cart's recommendations are both
that shape.

## The thing that makes it safe

**These feeds are cached for an hour. The price is not cached.**

That is the whole design. The cached pool holds books; `attachShopFields` puts
the price on afterwards, on every request, from two batched lookups over the
page's ISBNs. So the ordering may be up to an hour old and the price never is.

The split matters because the two go stale differently. A stale *ordering* is
invisible — nobody knows which book "should" have been third. A stale *price* is
a customer seeing one number on the shelf and a different one in their basket,
which is the failure the whole shop design exists to avoid, and which
`shop-integration.md` states as a rule: a price must not be cached and assumed
to hold.

Currency is resolved per request for the same reason. One cached pool is shared
by every viewer, so a visitor in Lagos and one in Berlin must not see each
other's money.

## Non-obvious decisions

**Attached at the return, not at the cache write.** Every feed ends by reading
or building a pool and then calling `attachShopFields`. Putting it before the
`redis.set` would have been simpler to write and would have cached an hour-old
price for everybody.

**A book with no live stock row comes back without the fields**, rather than
with zeros. Absent means "unknown"; a zero here reads as "free".

**`inStock` comes too, not just the price.** A rail that can show a price but
not whether the book is available would still need the second request it was
meant to avoid.

**Nothing changes without `shoppable=true`.** The fields are absent by default,
so existing callers see byte-identical responses.

## Verification

Against the local database with the server running:

- All four feeds return a price and `inStock` with `shoppable=true`; none of
  them do without it.
- **No cached payload contains a price.** Walked all five live `trending:*` and
  `similar:*` keys in Redis and grepped each for `unitPriceMinor`,
  `compareAtMinor` and `inStock` — none present.
- **Prices are genuinely live.** Bumped a supplier price by £10 with the feed
  cache left warm; the feed price moved 6932 → 8240 on the very next request,
  then restored it.

`src/__tests__/feed-prices.test.ts` holds the ordering: no feed returns rows
without attaching, nothing is attached before a cache write, currency is
resolved per request, and the fields are omitted when the caller did not ask to
shop.

**Also fixed:** `shoppable` was undocumented on `trending`, `personalized` and
`recommendations` — they accepted it and the spec never said so. All four feeds
now document it.

## Cost

Two extra batched queries per shoppable feed request, both keyed on the ISBNs
already in hand. The same bargain `GET /books` already makes, and only paid when
the caller asked to shop.
