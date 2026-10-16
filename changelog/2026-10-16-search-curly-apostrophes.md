# Search finds titles whichever apostrophe you type

**Date:** 2026-10-16

## What changed

Searching "baba segi" found *The Secret Lives of Baba Segi's Wives*, but "baba segi's"
returned nothing or unrelated books. Any title with an apostrophe had the same problem when
it was searched from an iPhone.

The cause: iOS Smart Punctuation, which is on by default, turns a typed `'` into the curly
`’` (U+2019). Most catalogue titles store the straight `'` (about 4,500 against 650 curly
ones), and search compared the two characters literally:

- **Exact-match tiers** (title prefix and word-prefix `ILIKE`, and the contributor-name
  prefix arms) — `'% baba segi’s%'` never matches `Segi's`.
- **Full-text search** — `plainto_tsquery('english', 'baba segi’s')` yields
  `'baba' & 'segi’'`, but the stored title indexes as `segi`.
- **Fuzzy tier** — trigram similarity ignores punctuation and still scored 1.0. But a
  search only reaches this tier when the exact tiers find nothing, and by then it ranks the
  whole fuzzy pool, so the real book did not make it onto the page.

Now:

- Every LIKE pattern search builds (`likePrefix` / `likeWordPrefix` / `likeContains`)
  turns an apostrophe *inside a word* (a letter, digit or combining mark on both sides)
  into LIKE's single-character wildcard `_`, so `segi’s` and `segi's` both match `Segi's`
  and `Segi’s`. These helpers are shared, so book, author, user, group, mention and
  shelf-title search all get the fix.
- Full-text search ORs the query in both spellings via a new `plainTsQuery` helper. This
  covers books, contributor names, and the book-title arm of community search, plus user
  and group search. A query with no apostrophe compiles to the same single
  `plainto_tsquery` call as before.
- The Redis keys for search rows, counts, split bands, suggestions and author suggestions
  are version-bumped, so pages cached before the deploy (wrong for these queries) are not
  served afterwards.

## Decisions

- **Wildcard, not normalisation.** Converting the query to a straight `'` would fix the
  common case but break the ~650 titles stored with `’`. A `_` matches either one and needs
  no migration or re-index. The trigram GIN index and the `text_pattern_ops` prefix index
  both still apply, because the fixed prefix before the wildcard is unchanged.
- **Only inside a word.** Any other apostrophe stays a literal `'`. A bare `'` turned into
  `_` would match every row, the `%%%`-matches-everything hole `escapeLike` exists to
  close. A trailing one ("the’") would match "the" plus any character, about a third of
  the catalogue. The cost: while someone is mid-typing "segi’", a title stored curly does
  not match until they type the next letter.
- **Combining marks count as letters.** Decomposed text ("ĩ’" as `i`, U+0303, `’`) would
  otherwise leave the apostrophe literal.
- **Both spellings for full text.** A tsvector keeps the apostrophe it was built from, so
  matching every title means trying both.

## Out of scope

- **Folding apostrophes in stored data.** Writing `’` as `'` in the search_vector trigger
  and the indexed title/name expressions would let one spelling match everything, but it
  needs a reindex/backfill of the whole catalogue on production. The query-time fix covers
  every current search path without that.
- **Post-text search** (`post_search_text`) is left as it is. Its integration suite already
  covers curly-apostrophe post bodies.
- **Typeahead speed.** Suggestions that fall through to the fuzzy tier took ~55–70s in
  the manual run below, just as slow without any apostrophe ("sky wolf", "captain mani").
  That predates this change and needs its own profiling.

## Verified

- Unit tests for the pattern helpers, `apostropheVariants` and `plainTsQuery`. The full
  suite passes (1,569 tests).
- `search-apostrophes.integration.test.ts` against a scratch Postgres: ILIKE word-prefix,
  the fast tier's `lower() LIKE` shape, and the OR'd tsquery (match and `ts_rank`) each
  match titles and descriptions stored with either apostrophe. The full integration suite
  passes (189 tests).
- Real `booksService.list` / `suggestions`, read-only against the production database
  (`.env` pointed there at the time). Before the fix, "captain mani’s" and
  "sky wolf’s" returned unrelated books. After it, "captain mani’s war" → *Captain Mani's
  War*, "sky wolf’s call" → *Sky Wolf's Call*, and both "elly pear's fast" and
  "elly pear’s fast" → *Elly Pear’s Fast Days and Feast Days* (stored curly).
