# Recommendation feeds only show books that are in stock

**Date:** 2026-10-05

## What changed

Every recommendation surface now shows only books that Gardners has on the shelf right now. Before, a feed could include books that can be bought but have to be ordered in: Gardners' extended catalogue (`GXC`), print-on-demand titles (`M/D`), and anything out of stock today. Those came back with `inStock: false`. Example: a classics shelf returned *David Copperfield* (9789357022606), an extended-catalogue title with no shelf stock.

Affected surfaces, all built on one shared filter:

- trending, personalised, "you may also like" (similar) and the basket carousel
- the reader-type rail and the bestseller chart
- the onboarding quiz's picks and the unprompted recommendation email

Every row from these feeds now carries `inStock: true`.

## What did not change

- **Search and browse** (`GET /books?shoppable=true`) still list order-in books, after the in-stock ones. Someone looking for a specific title should still find it, even if it takes longer to arrive.
- **Search-as-you-type suggestions** and a book page's **other editions** keep order-in titles for the same reason. They used to share the feed filter, so they now use the catalogue's looser filter instead.
- **What can be added to the basket** is unchanged. Order-in books are still buyable.

## Non-obvious decisions

- **Order-in books are most of the sellable catalogue.** That's about 1.19M of 1.65M sellable books (72%). Among books with an embedding, only ~312k of 1.2M (26%) pass the new filter. That raised the worry that similarity feeds would come back short. A check against production for three classics showed they don't: each still filled its 100-book pool, and the queries ran faster (≈0.7s against 1.5–3s), so pgvector's iterative scan wasn't needed.
- **"In stock" is `stock_qty > 0`.** That's the same test as the shop's IN_STOCK band and the `inStock` flag, so the filter and the flag can't disagree.
- **A feed book can now drop out between refreshes** when its last copy sells. Feeds aren't paginated, so this is acceptable here. It's not acceptable for the paginated `GET /books`, which is why that endpoint keeps stock-zero books and ranks them lower.
- **Some books can never appear in feeds.** Extended-catalogue and print-on-demand titles never have shelf stock.
- Cache keys were bumped (`trending:v8`, `personalized:v7`, `similar:v7`, `bestsellers:v5`) so feeds cached before the change aren't served afterwards. **The quiz recommendation cache was not bumped.** Its entries include LLM-written explanations and expire within 48 hours, so cached quiz results may still contain an order-in book until then.

## How it was verified

- `recommendation-sellability.test.ts` now asserts that the feed filter requires shelf stock, and that typeahead and other editions use the looser catalogue filter. Full suite: 1,218 tests pass. Typecheck is clean.
- Production data was checked read-only: the row for 9789357022606 (`stock_qty` 0, report code `GXC`), the sellable split by shelf stock, and the similar-books query for three classics with and without the new filter.
