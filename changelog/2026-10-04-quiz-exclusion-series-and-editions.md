# Stop hiding sequels, and catch more editions, when you've already read a book

**Date:** 2026-10-04

Second round of fixes to hiding books you've already read (see `2026-10-04-quiz-hides-books-already-read.md` and `2026-10-04-quiz-exclusion-review-fixes.md`), from a code review of PR #110.

## What changed

- **Sequels and companion books are no longer hidden.** A title's subtitle used to be cut off whenever it was compared with the plain title. So naming "Hedgewitch" also hid "Hedgewitch: Stonewitch", the next book in the series. A subtitle is now only cut when it describes an edition: it contains words such as "novel", "edition", "illustrated", "anniversary", "book club", "deluxe", "classic", "translation", "tie-in", "movie", "large print" or "Book 1 of". "Bel Canto: A Novel" still matches "Bel Canto"; "Hedgewitch: Stonewitch" and "Warriors: Fading Echoes" no longer match their series name.
- **"Book 1 of …" editions now match the plain title.** "A Game of Thrones: Book 1 of A Song of Ice and Fire" was treated as volume 1 and so as a different book from "A Game of Thrones", in both directions. A "1" in an edition subtitle is now ignored for that comparison. "A Clash of Kings: Book 2 of …" is still a different book.
- **Edition notes glued to the title.** "Bel Canto(Large Print)" and "Bel Canto—A Novel" now count as editions of "Bel Canto". Before, a bracket had to follow a space and a dash had to have spaces around it. An unspaced hyphen ("Catch-22") or en dash ("1914–1918") is still part of the title, as is a bracket inside it ("Friend(s) Forever").
- **No more lost exclusions when two look alike.** When loading the books you've read, rejected or own, near-duplicates were merged using the old title rule. Two entries like "Tokyo Ghoul (Vol. 2)" and "Tokyo Ghoul Vol 2" were collapsed into one, and the one thrown away could be the only one that matched a particular edition. They're now merged using the same keys the match uses.
- **The agreement test now runs on every commit.** The test that runs the database version of the rule and checks it against the in-memory version moved from the opt-in integration suite into the endpoint contract suite (`src/__tests__/exclusions.contract.test.ts`). The pre-commit hook already runs that suite against the `.env` database. The test reads and writes no tables: the catalogue tables are replaced by in-query fixtures. So it is safe against any database.

## Effect

On the local catalogue, the rule now matches 627 more pairs of books by the same author than the original plain-title rule (the first version matched 739). A sample of 30 of these was almost entirely genuine editions: movie tie-ins, signed, deluxe and annotated editions, book-club picks. One borderline case: "Batman: The Long Halloween: DC Compact Comics Edition" matches "Batman", because its subtitle contains an edition word.

## How it was verified

- **Unit tests:** the full suite passes (1,216 tests), with new cases for every fix.
- **Contract suite:** passes against the local database (26 tests, 20 of them for the exclusion rule).
- **Whole catalogue:** across all 83,688 local books, the SQL and TypeScript title keys agree on every title. With 200 excluded books, both filters remove the same books.
- **Speed:** 200 excluded books over the whole catalogue take about 815ms (750ms before this round). The edition-word check only runs on titles that have a subtitle separator. The quiz search only runs the filter on the rows pgvector's index returns.
