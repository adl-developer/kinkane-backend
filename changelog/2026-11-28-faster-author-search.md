# Faster author search: index whole-word name matches

## What changed
A new index, `idx_book_contributors_norm_name_tsv`, is added to `book_contributors`. It is a
GIN index on `to_tsvector('simple', <normalised person name>)`, built `CONCURRENTLY` by
`db/setup.ts` next to the existing trigram and prefix name indexes.

## Why
Author search's fuzzy step matches a name if it is trigram-similar to the search *or*
contains its words: `q <% name OR to_tsvector('simple', name) @@ …`. Only the trigram side
had an index. Postgres can't use an index for just one side of an `OR`, so every fuzzy
author search read all ~3M contributor rows. On prod that took 3–4 s per search, and it
was one of the queries behind the 2026-11-27 database CPU spike.

## Decisions
- The expression comes from `NORMALISED_PERSON_NAME`, the same constant the query uses. It
  has to match character for character, or the planner ignores the index.
- The `'simple'` config matches the query: words are lowercased, with no stemming and no
  dropped words, which suits names.

## Out of scope
- Searches shorter than 3 characters don't use the whole-word check, so they're unchanged.
  Their fuzzy step already stops early at its LIMIT.
- Author search still looks up matched books one at a time afterwards (up to 25k lookups
  for common fragments). That's a separate fix.

## Verified
On a scratch copy with prod's 3M contributors, using the real query builder with
EXPLAIN ANALYZE:

| Search | Fuzzy step before | Fuzzy step after |
|---|---|---|
| stephen king | ~1050 ms, parallel full scan | ~170 ms, bitmap index scan |
| smith | ~720 ms, parallel full scan | ~100 ms, bitmap index scan |

`setup.ts` built the index in about 6 s (59 MB) and it is valid. Prod needs `db:init`
(`setup.ts`) run against it for the index to exist there.
