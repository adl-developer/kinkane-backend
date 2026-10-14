# Multiple posts per book, and "Edited" markers on posts and comments

**Date:** 2026-10-14

## What changed

**Several posts about one book.** You can now post about the same book as
often as you like, for example once while reading and again when finished.
Each post is separate in the community feed and nothing is replaced. Before
this change, `POST /community/posts` returned 409 "You have already posted
about this book" because of a unique index on (user, book). To get around
that, the app edited the existing post, so the "reading" update disappeared
from the feed.

**Edit markers.** Every post and comment now carries:

- `isEdited`: true once the author has changed the content.
- `editedAt`: when that last happened, or null.

For a post, the content is the body, rating or status. For a comment, it is
the text. Two things do **not** count as edits:

- Making a post public or private.
- Resending the same values.

So "Edited" only appears on content that actually reads differently.

The fields appear on:

- Every post list: feed, your posts, posts for a book, book reviews and search.
- A single post.
- Comments.
- `myReview`.
- The friend's-book page, as `reviewIsEdited` and `reviewEditedAt`.

`PATCH /community/posts/{id}` now returns `{ success, post }`, with the post as
it now stands. `PATCH /community/comments/{id}` returns `{ success, comment }`.
The app can show the marker straight away without refetching. `success` is
kept, so existing clients are unaffected.

## Which post is shown when there are several

- **`myReview`** (book cards, shelves, recommendations, book page) is your
  **latest** post for that edition.
- **Friend's-book page:** the rating, review text and edit state all come
  from their latest visible post. Mixing posts could have shown an old
  rating next to newer words ("2★ — rereading, loving it"). If that latest
  post is an unrated "reading" post, no rating is shown.
- **Feeds, book review lists and search** list every post.
- **Profile `postCount`** counts every post.

## Repeat submissions

Without the one-per-book rule, a double tap or a retry would put two identical
posts in the feed. Now, an identical post (same status, rating and body)
about the same book within two minutes of the last one returns that post's
`id` with **200** instead of creating another. A per-(reader, book) advisory
lock inside a transaction covers simultaneous submits. Posting the same words
again later, or anything different, is a new post as normal.

## Data

Migration `0081_posts_multiple_per_book_edited_at`:

- Drops `idx_posts_user_book`, which was unique on (user_id, book_id).
- Adds a non-unique `idx_posts_user_book_created` on
  (user_id, book_id, created_at DESC), which serves the "latest post" lookups.
- Adds a nullable `edited_at` column to `posts` and `comments`.

## Decisions

- **Why a new column instead of `updatedAt`.** `updatedAt` also moves on a
  visibility switch, so it would mark posts "Edited" whose text never changed.
  It keeps its existing meaning, "anything changed".
- **The edit check runs in SQL.** It is a
  `CASE WHEN col IS DISTINCT FROM new THEN now() ELSE edited_at END` inside the
  UPDATE, compared against the row being updated. A read-then-write could race
  a concurrent edit.
- **Text is compared as the author sees it.** When a PATCH resends a body or
  comment that reads exactly as it does now, nothing is stored. Without this,
  a handle that has started naming an account since the post was written
  would re-tokenise. That would mark the post "Edited" and notify someone the
  author never chose to mention.
- **One clock.** `updatedAt` and `editedAt` are both set from the database's
  `now()` in the same statement, so they agree exactly.
- **Existing rows start as not edited.** Past text edits can't be told apart
  from past visibility toggles, so no backfill.

## Out of scope

- Group discussion comments and shelf notes. They also have edit endpoints but
  don't have edit markers yet.
- **The app must change its "finished reading" flow** to POST a new post
  instead of PATCHing `myReview.postId`. Until it does, it will keep editing
  the old post.

## Verification

- **Unit suite:** 1471 tests pass. The my-reviews tests now assert the
  DISTINCT ON / newest-first ordering and the `isEdited` mapping.
- **Integration:** a new `multiple-posts-edited.integration.test.ts`, run with
  the rest of the integration suite against a fresh pgvector:pg18 database
  with all migrations applied. All 157 tests in 15 files pass. It covers:
  - Two posts on one book are both listed.
  - `myReview` picks the newest.
  - The friend page takes its rating and review from the same, latest post.
  - Body, rating and status edits are marked.
  - Visibility-only and identical resends are not marked.
  - An earlier `editedAt` survives a later no-op patch.
  - Comment edit markers.
  - Repeat submissions: one in sequence, three at once, variants and an
    expired window.
  - A newly-existing @handle not counting as an edit.
  - Matching timestamps.
