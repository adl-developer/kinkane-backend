# Code review fixes: paging, edition choice and stock figures

A code review of the book-quantity branch (available quantity, GBP-only
pricing, one edition per title, top-level genre names) found the issues below.
All are fixed here.

## Paging with `cursor` skipped and repeated titles

Both bugs are older than this branch. They mattered more now because one
edition per title became the default.

- **Titles were skipped for good.** Each page scans 20 extra rows so collapsing
  editions still fills it. The cursor then moved past *every* scanned row, so
  any titles in the window beyond the first `limit` never appeared. On a
  newest-first page that was 17 of 37. The cursor now resumes at the first
  scanned row whose title the page didn't show.
- **The already-shown titles dropped the wrong end.** The cursor carries the
  last 100 titles shown, so later editions of them are filtered out. It was
  built newest-first and then kept the *oldest* 100, which let a title repeat
  on the very next page. It now keeps the newest.
- **Title and newest orderings are now total.** Both end with `books.id`, so rows
  that tie (editions sharing a title, books released the same day) come back in
  the same order on every request.

Measured on the local catalogue, 30 pages newest-first went from dozens of
repeats and skips to 600 distinct titles with none repeated or skipped. Title
order and searches were also clean.

**Still open: the default order (`updated_at`).** It gets no `id` tiebreaker.
Bulk loads stamp whole batches with one timestamp, so its tie groups can be a
large share of the catalogue, and sorting them on every page needs a new
`(updated_at, id)` index first. The shop listing's default order has the same
problem on `main` today: 102 repeated books over 30 plain-offset pages. It
needs that index, which is a migration and is left for a separate change.

A few repeats remain possible after a long walk. The sibling swap can show a
title's best edition early, and that edition's own position can come up again
once the title has aged out of the cursor's 100-title memory.

## Edition choice

- **In stock beats order-in.** Decided in review. The picker ranks editions on
  the shelf first, then order-in (extended catalogue, print on demand), then
  unavailable, and only then by format. Before, "buyable" treated order-in and
  in-stock the same, so an order-in paperback beat an in-stock hardback and the
  shop's in-stock section could lead with a book that wasn't in stock.
- **Siblings must still match the search.** On an author search, a swapped-in
  edition must itself match the searched name. Before, sharing *any*
  contributor was enough, so an illustrator's match could bring in an edition
  credited only to the co-author. On a blended search it must match by title or
  by name.
- **Names match in either order.** "Achebe, Chinua" now matches "Chinua Achebe",
  the same comparison the book page's other-editions list uses.
- **Per-title cap instead of a page-wide one.** Up to 10 editions per title,
  best-stocked and paperback-first. Before, a flat 300 with no order meant one
  classic with hundreds of editions could crowd out every other title on the
  page.

## Stock figures

- **A withdrawn book always shows `availableQuantity: 0`** (and ranks as
  unavailable). Its book page can still be opened, but add-to-cart rejects it.
- **`availableQuantity` added to** the book page's `otherEditions`, reading
  shelves (`/user-books`) and saved books. Saved books use the cart's own
  figure for the viewer's destination, so it includes rights restrictions.
- **Docs now say plainly that `availableQuantity` decides the Add button.**
  `shoppable: true, inStock: false` covers both order-in titles and ordinary
  out-of-stock ones, and only `availableQuantity` tells them apart.

## Smaller fixes

- `/books/search` no longer leaks internal scoring fields (`genreCount`,
  `hasPrice`, the stock tier) into its response and cache.
- Genre queries have a fixed order, so a collapsed genre name keeps the same
  slug on every read and in both list and detail.
- Comments and API docs that still described currency conversion now say GBP,
  unconverted.
- Shop integration guide: new section on one edition per title and on paging
  with `cursor`. **The web app used to rely on seeing every edition with plain
  offsets. It now needs to page with `cursor`, or send `dedupe=false`.**

## How it was verified

- New unit tests cover the stock tiers (in-stock hardback beats order-in
  paperback, order-in hardback beats unavailable paperback, paperback wins
  within a tier) and `stockTierFor`. Two tests that read source text were
  updated for the `id` tiebreaker and to scope their search to one function.
  Full suite passes (971 tests).
- Walked 30 cursor pages on the local catalogue: newest-first 600/600 distinct,
  no skips; title order, shop by title and searches clean.
- Checked live: suggestions carry only public fields, every `otherEditions`
  entry has `availableQuantity`, and shelves return it with top-level genre
  names. There are no saved books locally, so that path is covered by the type
  checker only.
