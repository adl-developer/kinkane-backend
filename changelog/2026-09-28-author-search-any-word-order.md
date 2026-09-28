# Find authors whatever order or punctuation their name is typed in

**Date:** 2026-09-28

## What changed

Author search now matches a name regardless of word order, commas or full stops.
"Shakespeare, William", "shakespeare william" and "William Shakespeare" return the same
author, and so do "Hunt, Roderick", "King Stephen", "Tolkien, J.R.R." and "Seuss, Dr.".
This covers both the author typeahead (`GET /authors/search`) and author-mode book
search (`GET /v2/books?type=author`, plus the v1 blended search that shares its name
matching).

The typeahead also changed in three smaller ways:

- **One entry per author.** About 22% of contributor names arrive from the feeds with
  doubled spaces, so "Roderick Hunt (171)" and "Roderick  Hunt (6)" used to be two
  suggestions. They are now one: "Roderick Hunt (177)".
- **Prolific authors first on ties.** "shakespeare" used to offer Nicholas Shakespeare
  (2 books) above William (76). Within a match tier, suggestions are now ordered by book
  count. That also fixes typos: "Rowlng" used to put Ian Rowland and Jennifer Rowley
  above J.K. Rowling, and now puts Rowling first.
- **Indexed fuzzy matching.** The fuzzy fallback compared against the raw name column,
  which no index covers. It now uses the normalised name that the indexes are built on.

## Why

Before this change, the exact-match tiers compared the query as one in-order string. A
query in "Surname, First" form matched none of them and fell through to the fuzzy tier.
It usually still found the author, but:

- The total was a capped estimate. "Shakespeare, William" reported **20** results against
  **76** for "William Shakespeare", and "Hunt, Roderick" reported 20 against 182.
- Near-miss names were mixed in. "Smith, Zadie" listed Maudie, Dodie and Kaylie Smith
  alongside Zadie Smith.
- It took about 3x longer.

Malformed supplier names had the same problem. "Ary L., MD, FACC  Goldberger" could only
be found by typing "Goldberger" on its own. "Goldberger, Ary" and "Ary Goldberger" now find it.

## How it works

The query is split into words on whitespace, commas, full stops, hyphens, apostrophes,
brackets and slashes. A name matches if **every word starts some word of the name, in any
order**. This check is added to the existing word-prefix tiers (tiers 1 and 3 in
`buildAuthorMatchSource`), so these matches rank as exact matches and are counted
exactly. The tier ladder, the A01-above-other-roles rule and the per-branch caps are unchanged.

Helpers are in `lib/contributor-name.ts`: `nameSearchWords`, `nameWordStartPattern` and
`wantsAnyOrderNameMatch`.

Non-obvious decisions:

- **Word start, not substring.** "hunt rod" reaches "Roderick Hunt", but "son smith"
  does not reach "Johnson Smith". Mid-word fragments are left to the fuzzy tier, so the
  exact tiers stay precise.
- **Only for queries of two or more words, at least one of them 3+ characters.** A
  single word is already covered by the prefix and word-prefix arms. A query of only
  initials ("j k") gives the trigram index nothing to look up, so the extra arm would be a
  regex scan over every contributor row.
- **Separators are listed explicitly, not written as a POSIX class.** The database ctype
  is C, so `[[:alnum:]]` would treat accented letters as separators.
- **Matched with `~*` against the normalised-name expression**, so the existing trigram
  index serves it. No new index is needed for the matching itself.

## Name indexes renamed

The earlier change that moved the name indexes onto the whitespace-normalised name reused
the index names. `CREATE INDEX IF NOT EXISTS` matches on name only, so a database that
already had the raw-column versions kept them. Every name query there then fell back to a
sequential scan, because the query's expression no longer matched the index. That was
confirmed on the local database: author search took about 350ms, and about 15–50ms after
the rename. The DigitalOcean database has no name indexes at all.

`db/setup.ts` now creates `idx_book_contributors_norm_name_trgm` and
`idx_book_contributors_norm_name_lower_pattern` and drops the old names. **Run
`db/setup.ts` against each environment** to pick this up.

## Out of scope

- **Collapsing initials.** "JRR Tolkien" and "JK Rowling" still rely on the fuzzy tier.
  They find the right author, but author-mode book search then gives an approximate
  total. "J.R.R. Tolkien" and "J. R. R. Tolkien" are still two typeahead entries.
- **Typeahead roles.** The typeahead still lists A01 authors only. Book search already
  includes editors, translators and illustrators.
- **Fuzzy tier ranking in book search.** It ranks by similarity only, so "Rowlng" in
  author-mode book search still leads with Rowlands. The typeahead fixes this with its
  book-count tie-break.
- **Full-text arm cost.** The fuzzy fallback's `to_tsvector` arm has no index. The
  typeahead fallback still takes about 200ms locally, as it did before this change.
- **Title+author split search.** The split search ("peace adzo medie") has its own name
  arms and is unchanged.

## How it was verified

- Unit tests in `author-search.test.ts` cover word splitting, the two-word/3-character
  guard, regex escaping, the any-order arm appearing on both tiers against the
  normalised expression, and single-word queries being unchanged. The full unit suite
  passes (1,059 tests).
- The real service code ran against the local database, with the cache bypassed, on
  about 20 queries before and after the change. Examples:

  | Query | Before (book search total) | After |
  |---|---|---|
  | Shakespeare, William | 20 (estimate) | 76 |
  | Hunt, Roderick | 20 (estimate) | 182 |
  | King, Stephen | 20 (estimate) | 25 |
  | Smith, Zadie | 20 (estimate, near-misses) | 1 (Zadie Smith) |
  | Goldberger, Ary | not found | 2 |
  | Seuss, Dr. | 20 (estimate) | 76 |

- `EXPLAIN ANALYZE` on the typeahead's exact tier for "Shakespeare, William" shows bitmap
  index scans on both renamed indexes, at 15ms, down from a 160ms parallel sequential scan.
