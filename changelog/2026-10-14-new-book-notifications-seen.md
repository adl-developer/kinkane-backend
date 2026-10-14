# New-book notifications: no more on quiz retake, and never a book you've seen

## What changed

1. **Retaking the quiz no longer sends a new-book notification.** Previously
   every `PATCH /recommendations/refresh` sent one (email, push and in-app
   notification) if the last one was more than 24 hours old. You had just been
   shown a full list of picks, so a "new book" on top of that was noise.
   New-book notifications now come only from the daily scheduled job, every 5
   days. A retake doesn't move that schedule.

2. **A new-book notification never names a book you have already seen.**
   "Seen" means:
   - on your shelf, favourites included (already excluded)
   - rejected (already excluded)
   - on your saved list (new)
   - removed from your shelf or saved list at any point (new)
   - already sent as a notification, in any edition (previously only that
     exact edition was blocked)

   All of these are matched **by work**: if you've seen the paperback, you
   won't get the hardback, the large-print or the "A Novel" edition either.
   This uses the same "same work" rule as rejections (`buildWorkExclusionCondition`).

   Quiz results you neither picked nor rejected are **not** treated as seen
   (product decision): they can come back as a recommendation later. Books you
   picked go onto your shelf and books you rejected are recorded, so every quiz
   book you acted on is already covered.

## Data

There is no new table; this builds on `user_books`, `saved_books`,
`user_disliked_books` and `recommendation_email_log`. The only schema change
(migration `0080_user_preferences_removed_books`) is
`user_preferences.removed_book_ids jsonb NOT NULL DEFAULT '[]'`.
`AFTER DELETE` triggers on `user_books` and `saved_books` fill it:
`remember_removed_book()` appends the book id unless it is already there.

A trigger rather than service code, because rows are deleted on several paths:
a shelf edit, pruning a row that no longer holds anything, unsaving, and
anything added later. Only the notification reads the column.

## Out of scope

- Books removed before this deploy: nothing recorded them, so they can't be
  backfilled.
- Books you only opened or scrolled past (product decision).

## Verification

- `recommendation-notifications.integration.test.ts`, run on a scratch pgvector
  database. Each kind of seen book has another edition nearer than the right
  answer. The pick skips all of them. A book removed twice is remembered once,
  and a second send skips the other edition of the first. The tests fail with
  the triggers dropped.
- `quiz-retake-no-notification.test.ts`: a refresh, with or without
  recommendations, sends nothing. It fails against the previous controller.
- Full unit and integration suites pass, and `tsc` is clean.
