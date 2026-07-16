# Soft-delete withdrawn books instead of hard-deleting them

**Date:** 2026-07-16

## What changed

Added `books.is_removed` (boolean, default false) and `books.removed_at`
(nullable timestamp). Migration:
[0019_wakeful_bushwacker.sql](../drizzle/0019_wakeful_bushwacker.sql).

`onix_ingester`'s ONIX chunk worker (`upsertBook` in `chunk.worker.ts`) used
to hard-delete a book's row when Gardners sent an ONIX "delete" notification
(`notificationType === '05'`, meaning the title was withdrawn from their
catalogue). It now sets `isRemoved: true, removedAt: now()` instead, and
clears both back to `false`/`null` automatically if a normal notification
for the same `recordReference` arrives later (e.g. the title is reissued).

## Why

Gardners' periodic full-catalogue re-syncs (see `onix_ingester`'s
`POST /gardners/bootstrap`, expected to run every few months) will include
delete notifications for anything withdrawn since the last sync. `books.id`
has `onDelete: cascade` foreign keys from `posts` (a user's rating/review of
that book — which further cascades to `comments`, `post_likes`, and
`comment_likes` on it), `user_interactions` (view/purchase/rating/wishlist
signals that feed recommendations), `user_books` (a user's reading-list
entry — status, notes, "liked" flag), and `recommendation_email_log`. A hard
delete was silently destroying all of that for any user who'd engaged with
a book Gardners later withdrew — not a hypothetical, since withdrawals are
a normal, expected part of a periodic full re-sync, not an edge case.

The four `gardners_*` satellite tables (`gardners_stock`,
`gardners_promotions`, `gardners_firm_sale`,
`gardners_market_restrictions`) already used `onDelete: set null` and were
never at risk. `recommendation_cache.recommendations` (a jsonb array of
bookIds) has no DB-level FK at all — stale ids there were already possible
regardless of hard or soft delete, unaffected by this change.

## What's explicitly out of scope

- No changes to any query in this repo that reads from `books` — search,
  browse, recommendations, book detail, a user's own reading list, and
  community post rendering all still query `books` without filtering on
  `is_removed`, so a withdrawn title will continue to appear everywhere it
  did before (the difference is now it doesn't destroy user content when it
  happens). Deciding which of those surfaces should hide removed books, and
  which should keep showing them (e.g. a user's own list, or an existing
  post about the book, probably should keep showing it with some "no longer
  available" treatment) is a product decision, not made here.
- No backfill — existing rows all start with `is_removed = false`.

## Testing done

- `tsc --noEmit` clean in both `server` and `onix_ingester`.
- `npm test` (vitest, 18 tests) clean in `onix_ingester`.
- Generated the migration with `npm run db:generate`, confirmed it's two
  additive `ALTER TABLE ... ADD COLUMN` statements plus an index.
- Ran `db:migrate` against the local dev database.
- Live end-to-end test against the real dev DB (temporarily exported
  `upsertBook` to call it directly, reverted after): created a real book
  row via a normal notification, attached a real `user_books` row and a
  real `posts` row to it, sent a withdrawal notification for the same
  `recordReference`, and confirmed the book row survives with
  `isRemoved: true` while the `user_books` and `posts` rows are untouched
  (previously these would have been cascade-deleted). Then sent a normal
  notification again and confirmed `isRemoved`/`removedAt` reset to
  `false`/`null`. Synthetic rows cleaned up afterward.
