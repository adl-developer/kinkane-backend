# Make Google Books a true last-resort cover fallback

**Date:** 2026-07-15

## What changed

Added `books.gardners_cover_checked_at` (nullable timestamp), owned by
`onix_ingester`'s `gardnersCoverService.syncFullCatalogue()`. Migration:
[0018_supreme_pixie.sql](../drizzle/0018_supreme_pixie.sql).

## Why

`onix_ingester`'s Gardners cover sync (full-catalogue backfill) and the
existing Google Books fallback both used to read/write the same
`cover_fetched_at` column to decide which books still need a cover. Since
both run in the same cron tick (Gardners first) but Gardners only processes
a small batch per tick, most books were still untouched by Gardners when
Google Books' own candidate query ran moments later — so Google Books ended
up racing Gardners for the same untouched population and doing most of the
initial cover-filling, rather than acting as a fallback for whatever
Gardners genuinely couldn't find.

Splitting the timestamp lets each source track its own attempt cadence
independently:
- `gardners_cover_checked_at` — set only when Gardners' full-catalogue probe
  checks a book (found or not).
- `cover_fetched_at` — now set only when Google Books attempts a book.

Google Books' candidate query (`onix_ingester/src/services/cover.service.ts`)
now requires `gardners_cover_checked_at IS NOT NULL` before it will touch a
book with an ISBN13 — it never fires until Gardners has already checked and
found nothing. Books with no ISBN13 skip that gate, since Gardners has no
way to look those up at all.

## What's explicitly out of scope

- No backfill of `gardners_cover_checked_at` for books Gardners has already
  implicitly covered (e.g. via the weekly `/Books/Update` zip feed, which
  also now stamps this column going forward) — existing rows just start
  from NULL and get picked up on Gardners' next full-catalogue pass.
- No change to the 30-day stale-retry window semantics, just which column
  each source uses for it.

## Testing done

- `tsc --noEmit` clean in both `server` and `onix_ingester`.
- `npm test` (vitest, 18 tests) clean in `onix_ingester`.
- Generated the migration with `npm run db:generate`, confirmed it's a
  single additive `ALTER TABLE ... ADD COLUMN` statement.
- Ran `db:migrate` against the local dev database and confirmed the column
  exists with the correct type via `information_schema.columns`.
