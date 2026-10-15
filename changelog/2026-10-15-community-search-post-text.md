# Community search finds posts by what people wrote

## What changed

`GET /api/v1/community/search` (the Posts results, and the posts in `filter=all`)
used to match only the **title of the book** a post is about. Searching for a
word someone actually wrote in a post returned nothing. Posts now match on the
book title **or** the post's own text:

- **Words, in any order and form.** `twist ending` finds a post containing both
  words anywhere; `reading` finds `read` (English stemming).
- **Quoted phrases.** `"slow burn"` — straight or curly quotes, as a phone types
  them — only matches posts with those words side by side.
- **Part of a word.** Three or more characters also match inside words, so
  `gripp` finds `gripping`.

Ranking: a match on the book title still comes first (as before), then posts
containing the exact wording typed, then posts using the words, then fuzzy title
matches. Ties go to the closest text match, then the newest post.

No change to the request or response shape — the app needs no update.

## Data

Migration `0084_posts_text_search` adds two columns to `posts`, both
`GENERATED ALWAYS … STORED` from `body`, so there is no backfill and nothing in
the app writes them:

| Column | What it holds | Index |
| --- | --- | --- |
| `search_text` | The body with mention/link tokens blanked, lowercased | GIN `gin_trgm_ops` (substring) |
| `search_vector` | `to_tsvector('english', …)` of the same text | GIN (words and phrases) |

Adding a stored generated column rewrites `posts` under a lock while the
migration runs. `posts` holds user-written posts only (not the 2M-row `books`),
so this is quick and does not need the concurrent-index path.

## Non-obvious decisions

- **Tokens are stripped before indexing.** Bodies store mentions as
  `@{{u:123}}` and links as `{{l:123}}`. Indexed as-is, searching an account id
  (or `u`) would match every post mentioning that person.
- **Lowercased under ICU, not the database ctype.** The database is ctype C,
  where `lower()` and `to_tsvector` leave non-ASCII capitals alone — `ÉMILE`
  would never find `Émile`. The columns lowercase with `COLLATE "und-x-icu"`;
  the query is lowercased with JavaScript's Unicode-aware `toLowerCase()`.
- **`english` config, unlike users and groups.** Those use `simple` because
  they are names. A post is prose, where stemming is what people expect.
- **Substring matching needs 3+ characters.** One or two letters appear in
  nearly every post, and the trigram index can't serve shorter patterns.
- **`%` and `_` in the query are literal.** The existing book-title matching
  never escaped them, so `%%%` returned every public post. Fixed for post
  search here; people and group search are fixed separately — see
  `2026-10-15-search-wildcards-literal.md`.

## Out of scope

- **Mentions by handle.** Searching `@ama` doesn't find posts that mention her,
  because the body stores her account id, not her handle. People search still
  finds her.
- **Comments.** Only the post's own text is searched.
- Visibility is unchanged: public posts only, as in the feed.

## Verification

- New `community-post-text-search.integration.test.ts` (11 tests) against a
  Postgres 18 database created with ctype C like production. It covers a body
  word, stemming, part of a word, quoted-phrase adjacency (including curly
  quotes), exact-wording-first ranking, title matches staying on top, accented
  capitals, token stripping (checked in the stored columns too), edits keeping
  the index current, private posts excluded, and LIKE wildcards.
- `EXPLAIN` shows both new GIN indexes used by a posts-only query. **The real
  search query didn't use them** (found in review); fixed in
  `2026-10-15-post-search-uses-indexes.md`.
- Full unit (1524), integration (176) and endpoint contract (31) suites pass.
