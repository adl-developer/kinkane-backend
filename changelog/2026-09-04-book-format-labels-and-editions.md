# Add plain-language format labels and sibling editions to book responses

**Date:** 2026-09-04

## What changed

Every book has always carried a raw `productForm` field — a two-character
ONIX code (`BC`, `BB`, `AJ`, …) for its format. Nothing ever translated it
into something a client could display, so the only way to show "Paperback"
instead of "BC" was for a client to hardcode its own copy of the ~180-code
ONIX List 150 codelist.

Two additions:

1. **`productFormLabel`** — computed server-side from a new `getProductFormLabel()`
   helper ([product-form.ts](../src/lib/product-form.ts)), backed by the
   full ONIX List 150 codelist. Added to every client-facing book response:
   `BookListItem`, `BookDetail`, `SuggestionItem`, `TrendingBookItem`
   ([books.service.ts](../src/services/books.service.ts)), and `UserBookItem`
   ([user-books.service.ts](../src/services/user-books.service.ts)). Returns
   `null` rather than guessing when `productForm` is `null` or an
   unrecognised code — it never fabricates a label.

2. **`otherEditions`** — on `GET /api/v1/books/:id` (`BookDetail`) only.
   Lists other formats of the same title, so the app can offer an "Also
   available as" switcher without a second query. Client integration details
   in [book-format-editions-client-brief.md](../docs/book-format-editions-client-brief.md).

## Why `otherEditions` is a heuristic, not a supplier link

The obvious way to link editions of the same work is ONIX's own
`<RelatedProduct>` / `<ProductRelationCode>` mechanism (List 51, e.g. code
30 "has other format"). Checked before building anything: Gardners' ONIX
feed doesn't send it at all — grepped the full tag set of a 1,000-product
live sample (`Sample Data/Gardners pBook Onix3 Sample.xml`) and
`<RelatedProduct>` doesn't appear once. `onix_ingester`'s parser
([parser.service.ts](../../onix_ingester/src/services/parser.service.ts))
doesn't parse it either, for the same reason — there's nothing to parse.

So `fetchOtherEditions()` matches on exact `title` + `publisherName` (both
indexed — `idx_books_title`, `idx_books_publisher` — so no table scan) plus
at least one shared contributor, name-normalised the same way author search
already is
([lib/contributor-name.ts](../src/lib/contributor-name.ts) — ~22% of
contributor rows have doubled internal spaces from the ONIX feed, which
would silently break a plain string comparison).

## The bug the contributor check almost let through

The first version matched on title + publisher + *any* shared contributor,
with no exclusions. Verified against the local dev DB (not just read the
code) before considering it done, and found a real false-positive class:

- 49 rows sharing `title = "SOS TITLE UNKNOWN"`, `publisher_name = "Not
  Stated"`, and a single contributor credited as `"UNKNOWN"` — a
  publisher-side sentinel for "we don't know," not a real person. All 49
  would have shown up as "other editions" of each other.
- The same shape recurs for `"VARIOUS"` / `"VARIOUS AUTHORS"` (50+9 rows in
  the sample) and `"ANONYMOUS"` / `"ANON"` (10+1 rows) — legitimate generic
  writing credits that aren't an identity.

Fixed with a `GENERIC_CONTRIBUTOR_NAMES` denylist in
[books.service.ts](../src/services/books.service.ts) (`fetchOtherEditions`),
matched as a normalised *whole name*, not a substring — a naive `LIKE
'%anon%'` would have wrongly caught real people like "Manon Tremblay" and
"Canon Mark Oakley." A book whose only contributors are generic credits now
matches nothing, rather than matching every other book with the same
generic credit.

Re-verified after the fix: the placeholder cluster now returns
`otherEditions: []`; legitimate multi-volume series with a real named editor
in common (e.g. Cambridge's "International Law Reports", "Shakespeare
Survey") still surface real siblings.

## What's explicitly out of scope

- **List/search/feed responses don't get `otherEditions`** — only
  `BookDetail`. Running the extra join on every row of a list would be an
  N+1 query; it only runs for the one book actually being viewed.
- **Internal-only types were left untouched on purpose**: `BuyableBook`
  ([availability.service.ts](../src/services/commerce/availability.service.ts)),
  `ParcelItem`
  ([parcel.ts](../src/services/commerce/parcel.ts)), and `productForm`
  usage in cart/checkout services. Those carry `productForm` purely for
  shipping-weight calculations and are never serialised to a client as a
  "book" — adding a label or sibling list there would be dead weight.
- **No re-check of whether Gardners' ONIX feed populates `<RelatedProduct>`
  for other product types** (only the pBook sample was checked) — if that
  ever turns out to carry data pBook doesn't, the heuristic above could be
  replaced with a real supplier-asserted link.

## Testing done

- `npx tsc --noEmit` — clean.
- Existing books-service test suite (`catalogue-filters`, `author-search`,
  `blended-search-merge`, `dedupe`, `bestsellers`,
  `title-sort-placeholders` — 85 tests) — all passing, unchanged.
- Manually verified `fetchOtherEditions` against the local dev DB via a
  throwaway script (not committed): confirmed it correctly groups a
  54-edition multi-volume series down to entries that share a named editor,
  confirmed the `"SOS TITLE UNKNOWN"` / `"Not Stated"` / `"UNKNOWN"` cluster
  returns `otherEditions: []` after the generic-contributor fix.
- No new automated test was added for `fetchOtherEditions` in this pass —
  it isn't exercised by the existing suite, and there's no fixture DB with a
  known multi-edition title to assert against yet.
