# Posting about a book you're still reading no longer needs a rating

## What changed

A community post has a status, `reading` or `read`. Until now every post had
to carry a rating (0–5), even when the reader was halfway through the book and
had nothing to rate yet. Now:

- a `reading` post can have no rating (`null`);
- a `read` post must still have one.

This applies to creating a post and to editing one.

## API

`POST /api/v1/community/posts`

```
{ "bookId": 48213, "status": "reading", "isPublic": true }                  // 201, rating stored as null
{ "bookId": 48213, "status": "reading", "rating": null, "isPublic": true }  // 201
{ "bookId": 48213, "status": "read", "isPublic": true }                     // 400
```

The 400 is the usual per-field validation error:
`{ "error": { "rating": ["A rating is required when status is read"] } }`.

`PATCH /api/v1/community/posts/{postId}`

`rating` now accepts `null`, which clears the rating. The rule is checked
against the post as it will be after the edit, because either field can change
on its own:

| Post before | Edit | Result |
|---|---|---|
| reading, rated | `{ rating: null }` | 200, now unrated |
| read, rated | `{ rating: null }` | 400 |
| reading, unrated | `{ status: "read" }` | 400 |
| reading, unrated | `{ status: "read", rating: 5 }` | 200 |
| reading, rated | `{ status: "read" }` | 200, keeps its rating |
| read, rated | `{ status: "reading", rating: null }` | 200 |

This 400 is a plain message, `{ "error": "A rating is required when status is
read" }`, not the per-field shape, because it needs the saved post and runs
after request validation. Editing someone else's post is still a 404, before
the rule is checked.

**Responses:** `rating` can now be `null` wherever a post's rating appears:
post responses, `myReview`, `GET /books/{id}/reviews` and community search.
The apps need to handle that before they start sending unrated `reading` posts.

## Database

Migration `0076_reading_post_optional_rating`:

- `posts.rating` drops `NOT NULL`. The existing 0–5 check still applies to any
  value that's set.
- New check `posts_read_rating_check`: `status <> 'read' OR rating IS NOT NULL`,
  so the database refuses an unrated `read` post even if it doesn't come
  through the API.

## Decisions

- **Existing posts are left alone.** Some `reading` posts may have been saved
  with `rating: 0` as a stand-in for "no rating". We can't tell those apart from
  real zero ratings, so they aren't converted to `null`.
- **0 is still a real rating.** A `read` post can be rated 0, as before.

## Verified

New `post-rating-reading.integration.test.ts` covers every case above through
the controller, plus the database check, against a throwaway Postgres with all
migrations applied. The unit tests (1,373), integration tests (106) and endpoint
tests (31) all passed, with none skipped.
