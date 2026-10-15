# Book and author search treat % and _ as characters too

Follow-up to `2026-10-15-search-wildcards-literal.md`, from code review.

## What was wrong

The wildcard fix escaped `%` and `_` at each place people, group and post
search built a LIKE pattern. Book title and author search (Explore, typeahead,
the split title-and-author band) built theirs the same hand-written way and
weren't touched, so `%%%` still matched every book. Fixing each place
separately also meant the next search someone writes would make the same
mistake.

## What changed

`src/lib/escape-like.ts` now has three helpers next to `escapeLike`:
`likePrefix` (starts with), `likeWordPrefix` (a word starts with) and
`likeContains`. Every LIKE pattern built from typed text goes through them:

- people, group, post and friend-picker search;
- @mention suggestions;
- book title search: full, fast-prefix and typeahead tiers;
- author-name search: suggestions and the split title-and-author band,
  including its title-word hits.

No search builds `q + '%'` by hand any more.

Escaped patterns still use their indexes: the trigram GIN index and the
`text_pattern_ops` btree on `lower(title)` both handle LIKE's backslash escapes.

## Verification

- `escape-like.test.ts` covers the helpers.
- `search-count-probes.test.ts` now records the parameters of every book-search
  query. It runs a title and an author search for `zq%_x` and checks that every
  LIKE pattern carrying the query has it escaped. The test fails against the
  previous book search code.
- Full unit and integration suites pass.
