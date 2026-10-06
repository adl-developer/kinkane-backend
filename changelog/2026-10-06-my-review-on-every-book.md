# Your own rating and review on every book

## What changed

Every book the API returns to a signed-in reader now carries `myReview`: their
own rating and review of that book, taken from their community post for it.
Before, the app only had this on the community screens, so a reader browsing
search results or their shelf couldn't see which books they had already rated.

```json
"myReview": {
  "postId": 3121,
  "rating": 4,
  "status": "read",
  "body": "Twelve voices and not one wasted.",
  "isPublic": true,
  "createdAt": "2026-09-21T19:04:00.000Z",
  "updatedAt": "2026-09-21T19:04:00.000Z"
}
```

It is `null` when the reader hasn't reviewed the book, and always `null` for
signed-out callers, so the response shape is the same either way.

## Where it appears

- Catalogue: `GET /books` (v1 and v2), `GET /books/search`, `GET /books/:id`
  (at the top level, next to `userStatus`), `GET /books/:id/similar`,
  `GET /books/recommendations`
- Discovery: `/explore/trending`, `/explore/bestsellers`,
  `/explore/personalized`, `/explore/reader-type`
- Recommendations: `PATCH /recommendations/refresh?includeRecommendations=true`
  and `POST /recommendations/selections`
- Shelves: `GET /user-books`, `GET /users/:userId/books`, `GET /saved-books`
- Groups: the group shelf list, a single shelf entry, the edit/finish/set-current
  responses, and `currentlyReading` on `GET /groups/:groupId`. On these it sits
  on the nested `book` card.
- Community: `GET /community/users/:friendId/books/:bookId`, so your own
  review shows next to your friend's

`GET /books`, `GET /v2/books` and `GET /books/search` used to ignore the
`Authorization` header completely. They now read it if it is there, so the
client needs to send the token on those calls to get `myReview`. A missing or
expired token still gets a normal anonymous response, never a 401.

## Decisions

- **The source is the community post.** A reader has at most one post per
  book, and the post is where the rating and review live. The shelf `note` is a
  different thing and still comes through `userStatus`.
- **Private posts are included.** This is the reader seeing their own review,
  so who else can see the post doesn't matter here.
- **Matched by edition, not by work.** If you reviewed the paperback, the
  hardback doesn't show your review. Editions are grouped by title rules
  (lib/dedupe), not by a stored work id, and guessing would put a review on a
  book the reader never reviewed.
- **A failed lookup never breaks the response.** If the review query fails,
  the books still come back, with `myReview: null`, and a warning is logged.
  The review is extra information on a response whose books have already
  loaded, so the book page's approach to public notes applies here too.
- **Added after caching.** Book listings are cached and shared between
  readers. The review is looked up per request in one batched query per
  response, after the cache, so it never gets into a shared cache entry.

## Left out

- The guest onboarding quiz (`POST /recommendations`). Guests don't have posts.
- Cart, orders and notifications. These are commerce and activity records, not
  book listings.
- Community post feeds. Each post already is the reader's rating and review.

## Verification

`my-reviews.test.ts` checks that reviews are matched to the right books, the
null cases, and that signed-out calls skip the database. It also renders the
query's filter to SQL and checks that it is limited to the caller's own posts.
Removing that condition makes the test fail. Without it, other readers' reviews
would show up as the caller's own. A failed lookup is tested to return
`myReview: null` rather than throw. Every schema reference in the API docs
resolves, and the book page is documented with the shape it returns: `book`,
`publicNotes`, `userStatus` and `myReview` at the top level. The docs had
previously put `userStatus` inside `book` too, and that is corrected here. The
full unit suite and the endpoint contract suite pass, and the TypeScript
typecheck is clean.
