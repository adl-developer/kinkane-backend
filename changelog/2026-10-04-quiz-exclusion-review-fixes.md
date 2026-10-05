# Close the gaps a code review found in hiding books you've already read

**Date:** 2026-10-04

Follow-up to the same day's change that keeps every edition of a book you've read out of your quiz results (see `2026-10-04-quiz-hides-books-already-read.md`). A code review of that change found eight problems. All are fixed here.

## What changed

- **Co-authors on your shelf and in your dislikes.** Before, only the quiz anchored a co-written book on every author. Books on your shelf, books you've swiped away and books in your basket still recorded just the first author. So an edition credited only to the second author ("Good Omens" credited to Neil Gaiman alone) could still be recommended on the home feed or in "you may also like". All of these now exclude every named author. The stored first-author snapshot on a dislike is kept, and widened with the book's live co-authors when the exclusion set is loaded.
- **Edition notes with numbers.** A number inside brackets used to count as a volume number. So "Moby Dick (Penguin Classics 100)" did not match "Moby Dick" and was still recommended. Inside brackets, a number now only counts when it follows a volume word (vol, volume, book, part, no, tome, level). "Tokyo Ghoul (Vol. 3)" and "Tokyo Ghoul (Vol. 9)" are still kept apart.
- **Non-breaking space after a colon.** One check in the database query ran without Unicode-aware matching. A title like "Bel Canto:" followed by a non-breaking space and "A Novel" was hidden in "you may also like" but shown in the quiz and on the home feed. It now uses the same Unicode rules as the rest of the query.
- **Author names that are only punctuation.** A contributor recorded as "." was treated as "author unknown", which hid every book with that title by any author. It is now treated as a recorded author, as before the original change.
- **Readers-like-you rail.** The rail now groups editions into works using the same title and author rules as the filter. So "Handmaid's Tale" and "Handmaid's Tale (Movie Tie-in)", or "Robert  Toft" and "Robert Toft", count as one work and appear once.
- **Database test.** A new integration test (`src/__tests__/exclusions.integration.test.ts`) runs the filter on a real Postgres and checks it against the in-memory version that "you may also like" uses. It covers the Bel Canto cases, series titles, volume numbers, co-authors, accents and non-breaking spaces. It writes nothing: the catalogue tables are replaced by in-query fixtures. Like the other integration tests, it only runs when `TEST_DATABASE_URL` is set.
- **Small clean-ups.** The query now strips brackets and the subtitle in one regex pass per book instead of two. The in-memory filter no longer copies its author lists on every insert.

## Caches

The per-user exclusion set is cached under a new key (`exclusions:v3`), so sets built before co-authors were included are not served for the rest of their hour.

## How it was verified

- **Unit tests:** the full suite passes (1,205 tests), with new cases for every fix.
- **Integration test:** passes against a local scratch database (13 checks).
- **Whole catalogue:** across all 83,688 local books, the SQL and TypeScript title keys agree on every title. With 200 excluded books, the SQL filter and the in-memory filter remove exactly the same books.
- **Rail:** the readers-like-you query runs against the local database and returns results.
- **Speed:** 200 excluded books over the whole catalogue now take about 750ms (630ms before these fixes, 310ms before the original change). The extra time is the bracket-aware volume check. The quiz search only runs the filter on the rows pgvector's index returns.
