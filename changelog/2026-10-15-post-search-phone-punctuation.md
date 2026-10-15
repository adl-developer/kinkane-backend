# Post search copes with phone punctuation, curly quotes and a leading dash

Follow-up to `2026-10-15-community-search-post-text.md`, from code review.

## What was wrong

- **A leading dash returned almost every post.** Word matching used
  `websearch_to_tsquery`, which reads `-word` as "posts *without* this word"
  and `or` as OR. Searching `-gripping` listed the whole public feed.
- **Phone punctuation glued words together.** The database is ctype C, where the
  text-search parser treats every non-ASCII character as a letter. Curly
  apostrophes, em dashes, ellipses and emoji (what an iPhone types) stuck to
  the next word: `Tolkien’s world—truly` was stored as `tolkien’s` and
  `world—truly`, so `world truly` found nothing.
- **Curly-quoted phrases weren't phrases.** Curly quotes were removed only for
  the exact-wording check, not for the word check, so `“reading slowly”` didn't
  find a post saying "read slowly".
- **The token pattern could drift.** The SQL that removes `@{{u:…}}` and
  `{{l:…}}` was copied into both generated columns, and nothing checked it
  against the TypeScript token formats.

## What changed

Migration `0085_post_search_text_normalised` adds one immutable SQL function,
`post_search_text(text)`. It applies NFC, lowercases under ICU, removes mention
and link tokens, turns every character that isn't a letter, digit or space into
a space, and collapses spaces. Both generated columns are redefined on it with
`ALTER COLUMN … SET EXPRESSION` (Postgres 17+, which rewrites the column), and
**every search query cleans the typed text with the same function**, so the
stored side and the typed side can't disagree.

Word matching is now built from `plainto_tsquery` for the loose words plus one
`phraseto_tsquery` per quoted part (straight, curly or low quotes), joined with
`&&`. Neither function has operators, so `-` and `or` are just text. A cleaned
query can't contain `%`, `_` or `\`, so the exact-wording `LIKE` needs no
escaping.

`MENTION_TOKEN_RE` and `LINK_TOKEN_RE` are now exported, and
`post-search-text.test.ts` checks that the newest migration defining
`post_search_text` uses exactly those patterns.

## Trade-offs

- Punctuation is no longer searchable inside post text: `100%` searches for
  `100`. Finding posts by symbols wasn't a goal.
- A change to `post_search_text` doesn't rewrite stored rows. It must be
  followed by `SET EXPRESSION` on both columns, as 0085 does. The migration
  comment says so.

## Verification

Integration tests added for a leading dash and `or`, iPhone punctuation (curly
apostrophe, em dash, ellipsis, emoji), straight and curly apostrophes matching
each other, and a stemmed curly-quoted phrase held to adjacency. The dash,
curly-phrase and token tests fail against the previous query code.
