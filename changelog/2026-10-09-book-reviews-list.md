# Every reader's reviews of a book, with yours pinned first

## What changed

New endpoint: `GET /api/v1/books/:id/reviews?sort=date_desc&limit=20&offset=0` (sign-in required).

It returns every reader's rating and review of the book, a page at a time. Each review has an `isMine` flag. If the signed-in reader has reviewed the book, their review is always the first item on page one.

```json
{
  "reviews": [
    { "id": 3310, "userId": 7, "userName": "…", "rating": 5, "body": "…", "isPublic": false,
      "likeCount": 2, "commentCount": 0, "likedByMe": false, "isMine": true, "…": "…" },
    { "id": 3290, "userId": 12, "isMine": false, "…": "…" }
  ],
  "total": 84,
  "sort": "date_desc",
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

Each item has the same shape as a community post (the existing post lists), with `isMine` added.

## Why

The book page could show the reader's own review (`myReview` on `GET /books/:id`) but not anyone else's next to it. The existing `GET /community/books/:bookId/posts` lists only public posts, doesn't mark yours, and puts it wherever its date falls.

## Decisions

- **Your review is pinned in the query itself.** It's done in the `ORDER BY` (`user_id = me DESC` first), not added to page one after the query runs. That way offset pagination stays consistent: your review is item 0 of the whole list, never shows up again on page two, and is counted once in `total`.
- **`sort` only orders everyone else's reviews.** Yours stays first in both orders. Ties are broken by id so pages don't shift when two reviews share a timestamp.
- **Your own private review is included; nobody else's is.** It's your review being shown back to you, which is the same rule `myReview` already follows.
- **All public posts count**, including rating-only posts and posts still at `reading`. This is the same set the existing per-book posts list returns.
- **Sign-in required.** Without a signed-in reader there's nothing to pin or flag.
- **Only this exact book id.** Reviews of another edition of the same title aren't included, for the same reason given in `my-reviews.service`: editions are grouped by heuristics, not by a stored work id.

## Out of scope

- Signed-out access.
- Gathering reviews across all editions of a work.
- Sorting by rating or by likes.

## Verification

- `book-reviews-list.test.ts` renders the generated SQL and checks three things: the filter (public, or the caller's own), that the pin comes first in the `ORDER BY` for both sort orders, and that `isMine` is set on the caller's review only.
- The full unit suite passes, and so does `tsc`.
- No run against a real database yet. There was no `TEST_DATABASE_URL` on the machine, and `.env` points at production.
