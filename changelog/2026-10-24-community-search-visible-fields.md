# Community search matches only what a result shows

## What changed

- **Posts** match on their book's **title and subtitle** (and, as before, on
  what was written in the post). The book's long description and ISBN no
  longer count.
- **Groups** match on their **name** only. The group description no longer
  counts.
- People search is unchanged (display name and username).

## Why

Results kept turning up that had no visible connection to the query. Post
search's full-text arm read `books.search_vector`, which also holds the
publisher's long description and the ISBN, so searching "war" returned every
post about any book whose blurb mentioned war. Group search's vector included
the description the same way. The person searching sees a title or a group
name, so a match hidden in a blurb looks random.

## How

- Post search builds a tsvector from title + subtitle per book instead of
  using `books.search_vector`. That column is left alone — book search still
  needs the description. The title test only visits books that have posts, so
  the lack of an index on this expression costs little. The same expression
  replaces `books.search_vector` in the ranking tie-break.
- Migration `0091_group_search_name_only` redefines the generated
  `groups.search_vector` as the name's words only. It keeps the GIN index, so
  multi-word queries still match in any order ("club harbour" finds
  "Harbour Book Club").
- API docs for `GET /community/search` and `GET /groups?q` updated.

## Out of scope

- The fuzzy title tier (`word_similarity > 0.5`) is unchanged; it can still
  produce near-misses.
- Book search (`/books`) still matches descriptions, on purpose.

## Verified

`community-search-visible-fields.integration.test.ts` seeds posts whose book
matches by title, by subtitle and only by description/ISBN, and groups that
match by name and only by description. It failed 3 of 4 before the change and
passes after; the other community and post search integration suites pass on
a migrated scratch database.

## Deploy

Run migration 0091 on prod. It rewrites the `groups` table, which is small.
