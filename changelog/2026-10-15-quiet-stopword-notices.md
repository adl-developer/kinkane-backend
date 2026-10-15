# Searches for common words no longer write notices to the server log

Follow-up to `2026-10-15-community-search-post-text.md`, from code review.

## What was wrong

When a text search has nothing to search for, Postgres sends a NOTICE: the
words are all English stop words ("the", "a", "is"), or nothing is left at all.
The app's Postgres client had no notice handler, so postgres.js printed each one
to stdout. Post-text search runs a word search for every query, so short or
common queries in Community search (and in book search, which already did this
for 3+ characters) filled the logs with lines like "text-search query contains
only stop words or doesn't contain lexemes, ignored".

## What changed

`src/db/notices.ts` is now the client's `onnotice` handler. It drops notices
whose message starts with `text-search query ` (the stop-words one and the
empty-query one) and prints every other notice exactly as postgres.js does by
default. Nothing else changes about how notices appear.

Only the app's main client (`src/db/index.ts`) uses it. The migration and setup
scripts keep the default, because their notices are worth seeing.

## Verification

- `db-notices.test.ts`: both text-search notices are dropped, and any other
  notice reaches `console.log` unchanged.
- An integration case searches `the` and `"the a"` through the real search and
  checks nothing about text search was printed. It fails without the handler.
