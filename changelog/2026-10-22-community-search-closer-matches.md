# Community search: closer matches only

## What changed

Community search (`GET /api/v1/community/search`) is stricter about loose
matches. A person, group or book title now counts as a "close" match only when
its trigram `word_similarity` with the query is above **0.5**. It was 0.3.

This applies in three places, to both the match condition and its ranking tier:

- people: matched by display name
- posts: matched by their book's title (posts still match on their book's
  title; only the fuzzy threshold changed)
- groups: matched by name, which also covers `GET /groups?q` because the
  Explore toggle uses the same builder

## Why

At 0.3, short queries brought back results that had little to do with what
was typed, so the results looked unrelated to the search.

## Trade-off

One-letter typos in short words stop matching. For example, "Haary" vs
"Harry" scores about 0.33. Words that share most of their letters with the
query still match. For "link", any word containing "lin" (Lindsay, Lincoln,
Blink) scores 0.6 and still comes back. Dropping those would take a threshold
of about 0.7.

## Out of scope

- Book search (`books.service.ts`) keeps its own 0.3 threshold.
- Post-text matching (stemmed words and exact wording) is unchanged.

## Verification

Unit tests for the group and post search conditions pass, and so does the type
check. The scores above were worked out by hand from pg_trgm's
`word_similarity` definition, not measured against a database.
