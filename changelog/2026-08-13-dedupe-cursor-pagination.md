# Stop a book appearing on two pages when browsing with dedupe on

**Date:** 2026-08-13
**Commit:** [58a9c2c](https://adl.github.com/adl-developer/kinkane-backend/commit/58a9c2c742ff6a4b2071c071af7ddd9252b1df03)

## What changed

`GET /books` now accepts an opaque `cursor` query param and returns a
`nextCursor` in its response body when `dedupe=true`. Passing the returned
`nextCursor` as `?cursor=` on the following request resumes at the right
raw position and filters out any titles already returned on the previous
page.

Offset pagination still works — it's the default for the non-deduped view
and any deduped client that hasn't been updated. The cursor is only
consulted when `dedupe=true`; ignored (with no error) otherwise, so a
hand-crafted request still works if someone drops the flag.

The cursor is a base64url-encoded JSON payload:

```json
{
  "o": 240,           // raw-row offset to resume scanning at
  "t": ["...", "..."] // case-folded titles from the previous page's tail
}
```

The tail keeps up to **100** titles — enough to cover any reasonable
overlap between consecutive pages without bloating the token. Decode is
defensive (bad shape, out-of-range offset, non-string titles all rejected
as null) so a bad or spoofed cursor is treated as no cursor.

## Why

Deduping happens after the raw rows are fetched — two editions of the
same book collapse into one row in the response. If page N ended on one
edition of "Beloved" and page N+1 started with another, both pages
returned Beloved as a distinct row. The user saw the same title twice as
they scrolled.

Offset pagination cannot fix this on its own: the collapse depends on
what's *on* the page, so pages don't align with dedupe boundaries. A
cursor carrying "titles I already returned" is the only stable way to
guarantee cross-page uniqueness.

## Data / API shape

Request:

```
GET /books?dedupe=true&limit=20             # first page
GET /books?dedupe=true&limit=20&cursor=<t>  # subsequent pages
```

Response adds:

```json
{
  "books": [...],
  "hasMore": true,
  "nextCursor": "eyJvIjoyNDAsInQiOlsi..."  // null on last page or when dedupe=off
}
```

## Non-obvious decisions

- **Cursor overrides `offset` when both are supplied.** The offset in the
  cursor is the correct resume position; keeping the caller's `offset` on
  top would double-advance.
- **Titles are the dedupe key.** Same case-folded key that `dedupeByTitle`
  in `lib/dedupe.ts` uses — a match here is exactly a match there.
- **Tail capped at 100 titles.** Larger than any reasonable overlap and
  small enough that the token stays under a few KB even at its cap.
- **`totalIsApproximate` remains true for any dedupe request.** The row
  count from the DB doesn't match the deduped item count; `hasMore` /
  `nextCursor` are the real pagination signals now.

## Verified

TypeScript compilation clean. Direct exercise of the cursor
encoder/decoder against these cases:

- Round-trip of a well-formed cursor recovers the same object.
- Malformed base64 input → `null` (falls back to offset).
- Empty string → `null`.
- Cursor with a negative offset → rejected (`null`).
- Cursor with 500 tail titles → capped at 100.

Cross-page duplicate suppression itself follows from the algorithm:
`nextCursor.o` advances past the raw rows we scanned, and `nextCursor.t`
carries the returned titles as an explicit filter, so any raw edition
past the page boundary is discarded before dedupe on the next request.
End-to-end request-response verification is left for staging.
