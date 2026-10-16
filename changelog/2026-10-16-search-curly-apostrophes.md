# Search finds titles whichever apostrophe you type

**Date:** 2026-10-16

## What changed

Searching "baba segi" found *The Secret Lives of Baba Segi's Wives*, but "baba segi's"
returned nothing or unrelated books. Any title with an apostrophe had the same problem when
it was searched from an iPhone.

The cause: iOS Smart Punctuation, which is on by default, turns a typed `'` into the curly
`’` (U+2019). Most catalogue titles store the straight `'` (about 4,500 in the local DB
against 650 curly ones), and search compared the two characters literally:

- **Exact-match tiers** (title prefix and word-prefix `ILIKE`, and the contributor-name
  prefix arms) — `'% baba segi’s%'` never matches `Segi's`.
- **Full-text search** — `plainto_tsquery('english', 'baba segi’s')` yields
  `'baba' & 'segi’'`, but the stored title indexes as `segi`.
- **Fuzzy tier** — trigram similarity ignores punctuation and still scored 1.0. But a
  search only reaches this tier when the exact tiers find nothing, and by then it ranks the
  whole fuzzy pool, so the real book did not make it onto the page.

Now:

- Every LIKE pattern search builds (`likePrefix` / `likeWordPrefix` / `likeContains`)
  turns an apostrophe that follows a letter or digit into LIKE's single-character wildcard
  `_`, so `segi’s` and `segi's` both match `Segi's` and `Segi’s`. These helpers are shared,
  so book, author, user, group, mention and shelf-title search all get the fix.
- Book full-text search (books search and the community search's book-title arm) ORs the
  query in both spellings via a new `plainTsQuery` helper. A query with no apostrophe
  compiles to the same single `plainto_tsquery` call as before.

## Decisions

- **Wildcard, not normalisation.** Converting the query to a straight `'` would fix the
  common case but break the ~650 titles stored with `’`. A `_` matches either one and needs
  no migration or re-index. The trigram GIN index and the `text_pattern_ops` prefix index
  both still apply, because the fixed prefix before the wildcard is unchanged.
- **Only after a letter or digit.** A lone `'`, or one that opens a word (`‘tis`), stays a
  literal `'`. Turning a bare `'` into `_` would match every row, which is the
  `%%%`-matches-everything hole that `escapeLike` exists to close.
- **Both spellings for full text.** A tsvector keeps the apostrophe it was built from, so
  matching every title means trying both.

## Out of scope

- The users/groups name search and post-text search full-text arms (`'simple'` config,
  `post_search_text`) still use a single spelling. Their LIKE arms are fixed by the shared
  helpers.
- Typeahead suggestions that fall through to the fuzzy tier take ~55–70s on the local DB.
  That is just as slow without any apostrophe ("sky wolf", "captain mani"), so it predates
  this change.

## Verified

- Unit tests for the pattern helpers, `apostropheVariants` and `plainTsQuery`. The full
  suite passes (1,568 tests).
- Real `booksService.list` against the local DB. Before the fix, "captain mani’s" and
  "sky wolf’s" returned unrelated books. After it, "captain mani’s war" → *Captain Mani's
  War*, "sky wolf’s call" → *Sky Wolf's Call*, and both "elly pear's fast" and
  "elly pear’s fast" → *Elly Pear’s Fast Days and Feast Days* (stored curly).
