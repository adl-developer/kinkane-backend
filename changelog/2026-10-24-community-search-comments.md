# Community search finds posts by their comments

## What changed

`GET /api/v1/community/search` now also returns a post when one of its
comments contains the search text. Before, only the book title (and subtitle)
and the post's own text counted, so a conversation under a post could not be
found.

Each post result has a new field, `matchedComment`. It holds the best-matching
comment (id, author, rendered body with mentions and links, createdAt) when
the post is in the results **only** because of a comment, and is `null`
otherwise. Without it the app would show a post with nothing on it that
explains why it matched.

## How matching works

- Comments are tested exactly like post text: whole words in any order,
  stemmed ("reading" finds "read"); quoted phrases as written; and, from three
  characters, part words ("gripp" finds "gripping"). @mention and link tokens
  are blanked first.
- Migration `0092_comments_text_search` adds generated `search_text` and
  `search_vector` columns to `comments`, built with the same
  `post_search_text()` as posts, plus their GIN indexes.
- Only comments the searcher could see in the thread count: not ones a
  moderator hid, not across a block in either direction, not by a blacklisted
  account. The post itself still has to be public and visible as before.

## Ranking

Comment-only matches rank last: book title → exact wording in the post →
words in the post → fuzzy title → title/subtitle words in any order →
comments. A post whose title matched in any way never gets `matchedComment`,
even if a comment matched too.

The matching comments are found once per search, as a derived table the post
query LEFT JOINs; both the filter and the ranking read whether a post has a
hit from that join, so the comments table is scanned once rather than once
per mention in the query. Something another person said
under a post is weaker evidence that the post is about the query than the post
itself. Within the comment tier, newest post first. The comment chosen for
`matchedComment` is the closest by word rank, then the newest.

## Out of scope

- Shelf (library) reviews and book-club (group) comments are not searched.
- No highlight offsets for the matched words.

## Verified

`community-search-comments.integration.test.ts` covers ranking below post
matches, `matchedComment` set only on comment-only matches, part words and
phrases, hidden/blocked (both directions)/blacklisted comments, and private
posts. `post-search-condition.test.ts` pins the comment test to its own
subquery. Full unit and integration suites pass on a scratch database.

## Deploy

Run migration 0092 on prod. It rewrites `comments` to fill the generated
columns and builds two GIN indexes — size the window to the table.
