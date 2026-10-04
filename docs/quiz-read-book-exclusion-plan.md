# Quiz: keep books the user has already read out of the results

**Status:** built 2026-10-04, with two rounds of code-review fixes the same day; in PR #110, not yet deployed.

## Goal

When a user types in a book they've already read, that book (in any edition or spelling) must not come back in the quiz results. Other books by the same author **stay in**. Only that author's books with a matching title are dropped.

## The rule as built

| Candidate's author vs. typed-in book's author | Title | Result |
|---|---|---|
| Same author (after name cleanup) | Matches | **Drop** |
| Either author unknown | Matches | **Drop** |
| Different, known author | anything | **Keep** (e.g. Toft's *Bel Canto* singing guide) |
| Same author | Doesn't match | **Keep** (e.g. Patchett's *Whistler*) |

**When two titles "match".** Each title gets two keys:
- **full:** the title with bracketed edition notes removed, then case, punctuation, "&" and a leading or trailing The/A/An ignored. A note counts when it's set off by a space, or glued to the end of the title ("Bel Canto(Large Print)"). A bracket that opens the title ("(Un)Natural") or sits inside it ("Friend(s) Forever") is kept.
- **core:** the same, with an *edition* subtitle also removed. A subtitle starts at `: `, ` - ` or an em dash, and counts as an edition subtitle only when it contains an edition word: novel, memoir, edition, illustrated, anniversary, book club, adapted, deluxe, classic, translation, tie-in, collector's, graphic, (un)abridged, annotated, large print, movie, film, prize, bestseller, "Book 1 of", and similar. Any other subtitle is treated as part of the title.

Two titles match when one's *full* key equals the other's *full* or *core* key. Core is never compared with core. So "Bel Canto: A Novel", "Bel Canto—A Novel", "Bel Canto (Harper Perennial Modern Classics)" and "Bel Canto [Large Print]" all match "Bel Canto". "Hedgewitch: Stonewitch" does not match "Hedgewitch", and "Warriors: Fading Echoes" does not match "Warriors: A Warrior's Choice".

**Volume guard.** Any volume or part numbers in the two titles must be the same. Outside brackets, that means any number up to three digits or Roman numeral like ii or xiv. Inside brackets, it means only a number after a volume word (vol, volume, book, part, no, tome, level). So "Tokyo Ghoul (Vol. 3)" and "Tokyo Ghoul (Vol. 9)" stay separate, but "Moby Dick (Penguin Classics 100)" still matches "Moby Dick". In the core key, a "1" in the cut subtitle is ignored, so "A Game of Thrones: Book 1 of A Song of Ice and Fire" matches "A Game of Thrones", while "A Clash of Kings: Book 2 of …" is a different book.

**Author name cleanup** (both sides): lowercase, full stops turned into spaces, runs of spaces collapsed, and a single "Surname, First" flipped. Suffixes like "King, Jr." and names with several commas are not flipped.

## Changes from the original plan

- **No similarity score.** Measured on the local catalogue, every pg_trgm cutoff from 0.6 to 0.95 mostly matched *different* books by the same author ("Theory A" / "Theory B", "Workbook with Key" / "without Key", "Vol. 3" / "Vol. 9"). Exact matching on the full and core keys covers the real edition variants without those mistakes. Typos in catalogue titles ("Bel Cantto") are not caught.
- **Subtitles are only cut on one side.** Cutting on both sides merged 15,609 pairs of books by the same author, almost all of them different books in a series.
- **Only edition subtitles are cut.** Cutting every subtitle hid sequels and companions that share a series name ("Hedgewitch: Stonewitch" once "Hedgewitch" was read). Limiting the cut to subtitles with edition words keeps those apart.

## What changed in the code

- `src/lib/exclusions.ts`:
  - New `normalizeAuthorForMatch` / `authorMatchSql`, `titleKeysForMatch` / `titleKeysSql`, and a volume-number helper.
  - `buildWorkExclusionCondition` (SQL) and `filterExcludedWorks` (in memory) now use the rule above.
  - New `WORK_MATCH_VERSION`.
  - Personalized feed cache prefix bumped to `v6`.
- `src/services/recommendations.service.ts`: the typed-in book becomes one exclusion per author, not just the first author. The quiz cache key includes `WORK_MATCH_VERSION`.
- Shelf books, disliked books and the basket also exclude every named author (`resolveAllAuthorWorks`). Exclusions cache key bumped to `exclusions:v3`.
- `src/services/books.service.ts`: personalized feed cache key bumped to `v6`; the readers-like-you rail groups editions on the same title key and author fold the filter uses.
- `src/__tests__/exclusions.contract.test.ts`: runs the SQL filter on a real Postgres and checks it against the in-memory filter. It's part of the endpoint contract suite, so the pre-commit hook runs it against the `.env` database on every commit. It reads and writes no tables.
- `getUserExclusions` removes duplicate works using the same keys the match uses, so two works that only look alike under the plain fold both survive.
- The filter is shared, so books the user disliked or already has on their shelf get the same matching across the home feed, "you may also like", the readers-like-you rail and recommendation emails.

## Verification

- **TypeScript and SQL agree.** Across all 83,688 local books, the two versions of the title keys agree on every title. With 200 exclusions, the SQL and in-memory filters remove the same books.
- **Effect:** the new rule matches 627 more pairs of books by the same author than the old rule did. A sample of 30 was almost entirely genuine editions (*Killers of the Flower Moon (Movie Tie-in Edition)*, *Animal Farm: Annotation Edition*, *Come and Get It: A GMA Book Club Pick*). One borderline case: "Batman: The Long Halloween: DC Compact Comics Edition" matches "Batman", because its subtitle has an edition word.
- **Speed:** 200 exclusions over all 83k books took about 815ms, against about 310ms for the old rule. The quiz search uses pgvector's iterative index scan, so the filter only runs on the rows the index returns.
- **Tests:** `npx vitest run` passes (1,216 tests). The contract suite passes against the local database (26 tests, 20 of them for the exclusion rule).

## Not in scope

- Fixing the doubled spaces in stored author names at the source (ONIX ingester).
- Catching typos in catalogue titles.
