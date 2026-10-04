# Quiz: keep books the user has already read out of the results

**Status:** built 2026-10-04, not yet committed or deployed.

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
- **full:** the title with trailing bracketed text removed, then case, punctuation, "&" and a leading or trailing The/A/An ignored.
- **core:** the same, with the subtitle (after `: ` or ` - `) also removed.

Two titles match when one's *full* key equals the other's *full* or *core* key. Core is never compared with core. So "Bel Canto: A Novel", "Bel Canto (Harper Perennial Modern Classics)" and "Bel Canto [Large Print]" all match "Bel Canto". "Warriors: Fading Echoes" does not match "Warriors: A Warrior's Choice".

**Volume guard.** Any volume or part numbers in the two titles must be the same: up to three digits, or Roman numerals like ii or xiv, anywhere in the title, including inside brackets. So "Tokyo Ghoul (Vol. 3)" and "Tokyo Ghoul (Vol. 9)" stay separate.

**Author name cleanup** (both sides): lowercase, full stops turned into spaces, runs of spaces collapsed, and a single "Surname, First" flipped. Suffixes like "King, Jr." and names with several commas are not flipped.

## Changes from the original plan

- **No similarity score.** Measured on the local catalogue, every pg_trgm cutoff from 0.6 to 0.95 mostly matched *different* books by the same author ("Theory A" / "Theory B", "Workbook with Key" / "without Key", "Vol. 3" / "Vol. 9"). Exact matching on the full and core keys covers the real edition variants without those mistakes. Typos in catalogue titles ("Bel Cantto") are not caught.
- **Subtitles are only cut on one side.** Cutting on both sides merged 15,609 pairs of books by the same author, almost all of them different books in a series.

## What changed in the code

- `src/lib/exclusions.ts`:
  - New `normalizeAuthorForMatch` / `authorMatchSql`, `titleKeysForMatch` / `titleKeysSql`, and a volume-number helper.
  - `buildWorkExclusionCondition` (SQL) and `filterExcludedWorks` (in memory) now use the rule above.
  - New `WORK_MATCH_VERSION`.
  - Personalized feed cache prefix bumped to `v6`.
- `src/services/recommendations.service.ts`: the typed-in book becomes one exclusion per author, not just the first author. The quiz cache key includes `WORK_MATCH_VERSION`.
- `src/services/books.service.ts`: personalized feed cache key bumped to `v6` (only change there).
- The filter is shared, so books the user disliked or already has on their shelf get the same matching across the home feed, "you may also like", the readers-like-you rail and recommendation emails.

## Verification

- **TypeScript and SQL agree.** Across the local catalogue, the two versions of the title keys and the author cleanup agree on all 83,706 titles and 88,395 author names. The one difference is a synthetic "Ⅻ" glyph, which the existing title fold already treats differently.
- **Full filter, SQL vs in memory:** 301 exclusions (including Bel Canto / Ann Patchett) run over all 83,688 books. Both versions remove the same 380 books, and Toft's *Bel Canto* is kept.
- **Effect:** the new rule matches 739 more pairs of books by the same author than the old rule did. In a sample of 40, most are genuine editions (*The Little Prince (Collector's Edition)*, *Handmaid's Tale (Movie Tie-in)*). About 1 in 10 is a different book (*Hedgewitch: Stonewitch*, *Meaning of Marriage: A Couple's Devotional*). That leans toward over-excluding, which is the existing design choice.
- **Speed:** 200 exclusions over all 83k books took about 630ms, against about 310ms for the old rule, or roughly 7.5µs per row. The quiz search uses pgvector's iterative index scan, so the filter only runs on the rows the index returns.
- **Tests:** `npx vitest run` passes, 1,195 tests. New cases in `src/__tests__/exclusions.test.ts`.

## Not in scope

- Fixing the doubled spaces in stored author names at the source (ONIX ingester).
- Catching typos in catalogue titles.
- Changing how the readers-like-you rail groups editions (it still groups on the plain title fold).
