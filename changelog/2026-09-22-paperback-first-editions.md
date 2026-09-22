# One edition per title on /books, paperback first

## What changed

Every `/books` endpoint now shows one edition per title by default, and picks
which one by a fixed rule:

1. **An edition that can be bought right now** (`availableQuantity > 0`)
2. **Paperback** (ONIX `BC`)
3. **Hardback** (ONIX `BB`)
4. **Any other format** (audio, ebook, board book, …)

If editions are still tied, the existing rules decide, in order: has a cover,
has a complete record, newest, has a price.

Covered: `GET /api/v1/books` and `GET /api/v2/books` (browse, filters and
search), `GET /books/search` typeahead, and the discovery feeds (trending,
personalized, similar), which already showed one edition per title and now use
the same rule.

## Why

A title often exists as a paperback, a hardback and several other formats. The
shop should lead with the edition most people buy, the paperback, and fall back
in a predictable order. It should never show an out-of-stock paperback when the
hardback is on the shelf.

## API shape

- `dedupe` now defaults to `true` on `GET /books` and `GET /books/search`.
  Send `dedupe=false` to list every edition, for example for an "other formats"
  view. **Clients that relied on every edition appearing by default must now
  send `dedupe=false`.** The route comments said the web app did.
- Paginate with `cursor` (`nextCursor` in each response), not `offset`. That was
  already the rule for the deduped path, and it's now the default path.
  `totalIsApproximate` is `true` on these responses.
- The response shape is unchanged.

## Decisions worth knowing

- **Buyable beats format.** Chosen explicitly: a buyable hardback is shown ahead
  of a paperback that can't be bought. When no edition can be bought, paperback
  still wins.
- **Every edition is considered, not just the ones on the page.** Before, the
  picker only compared editions that happened to fall inside the rows fetched
  for the page. That works when sorting by title, where editions sit together,
  but not when sorting by newest or in the shop's stock order: a hardback and
  its paperback are often published months apart. Measured on the local
  catalogue, that picked the wrong edition for about one title in ten. `list()`
  now also fetches the other editions of each title on the page
  (`fetchSiblingEditions`) before choosing. After this change the same audit
  found none wrong.
- **Siblings must share an author and pass the request's filters.** A sibling
  needs the exact same title *and* a shared contributor, matched the same way as
  the book page's "other editions" list. Without that, a search for Keats's
  *Poems* could be swapped for someone else's *Poems*. It must also pass the
  request's filters, so `yearMin=2024` can't bring back a 2019 paperback and
  `productForm=BB` still returns only hardbacks.
- **Recommendations unchanged.** The recommendation engine shares the edition
  picker but supplies neither stock nor format, so its ordering is unchanged.
- **Cache keys bumped** (`books:list:v8`, `suggestions:v4`, `trending:v6`,
  `personalized:v4`, `similar:v5`), so pages cached under the old rule aren't
  served after deploy. The personalized-feed cache clearing in `lib/exclusions`
  was bumped with it.

## Out of scope / known limits

- Typeahead groups editions by title *and subtitle*, as before, so two editions
  with different subtitles can both appear. For example, "Pride and Prejudice"
  appears twice when one edition carries a subtitle.
- Feeds choose within their own candidate pool and don't fetch other editions.
- Editions with no contributors can't be matched to their siblings, so they're
  only compared with editions already on the page.

## How it was verified

- New unit tests cover: paperback over hardback over other formats; paperback
  beating a hardback with a better record; buyable hardback beating an
  unbuyable paperback; paperback winning when nothing is buyable; ties between
  paperbacks falling back to the old rules; case-insensitive ONIX codes; and
  recommendation ordering unchanged. Full suite passes (956 tests).
- Audited live against a local copy of the catalogue by comparing every returned
  book with all its same-author editions. Browse by title, browse by newest,
  the shop listing (both orders) and searches for "harry potter", "dickens",
  "agatha christie" and "poems" all returned the best edition, with no title
  repeated across three pages. Before the sibling lookup, browse-by-newest and
  the shop listing were wrong on 6 of 60 books each. The one flag under
  `yearMin=2024` was correct: the buyable paperback is from 2019, and the filter
  excludes it.
