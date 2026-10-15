# Post search uses its indexes

Follow-up to `2026-10-15-community-search-post-text.md`, from code review.

## What was wrong

Post search's filter was one big OR over the joined row: book-title tests on
`books` alongside post-text tests on `posts`. Postgres can't use either table's
indexes for an OR that mixes them. So every search read every public post and
ran the trigram `LIKE`, the tsquery and `word_similarity` on each one. The
GIN indexes from 0084 sat unused, and the earlier claim that EXPLAIN showed
them in use was based on a simpler, posts-only query.

The title half had a second cost from before this branch: it compared a book's
title once **per post**, so a book with forty posts was compared forty times.

## What changed

The filter is now two `IN (subquery)` tests:

- **Text:** a subquery over `posts` alone (aliased `text_match`), where Postgres
  combines both GIN indexes (a BitmapOr).
- **Title:** a subquery over `books` (aliased `title_match`) limited to books
  that have posts, so each title is compared once.

The outer query only checks whether a post's id or book id is in those sets.
Ranking (the ORDER BY) is unchanged and runs only on matching posts.

## Measured

Scratch Postgres 18 (ctype C), 100k posts over 3k books, timings from the real
service call with plans captured by `auto_explain`:

| Query | Before | After |
| --- | --- | --- |
| a rare word (20 matches) | 625 ms | 54 ms |
| `slow burn` (77k matches) | 383 ms | 345 ms |

Broad queries are now limited by sorting their matches, not by finding them.
The synthetic word list makes most posts match. Real searches match far fewer.

## Verification

`post-search-condition.test.ts` compiles the condition and checks this shape:
text tests only inside the `text_match` subquery, title tests only inside
`title_match`, which is limited to books that have posts. All post-search
integration tests pass unchanged.
