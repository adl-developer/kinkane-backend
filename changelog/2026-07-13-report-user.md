# Let users report other users

**Date:** 2026-07-13
**Commit:** [b12544f](https://adl.github.com/adl-developer/kinkane-backend/commit/b12544f93a793142a3c63cd0bd7537e1ac560419)

## What changed

Readers can now file a report against another user's account. This is the
backend for the "Report User" screen in the app (reachable from a review —
e.g. reporting Kwame Asante over a specific review he posted).

A new `POST /api/v1/reports` endpoint accepts:

```json
{
  "reportedUserId": 123,
  "reason": "Free-text explanation from the reporter",
  "postId": 456
}
```

- `reportedUserId` — required. The account being reported.
- `reason` — required, 1–2000 characters. Free text only, matching the
  mockup (no category dropdown).
- `postId` — optional. If the report was filed from a specific review/post,
  its ID is recorded so moderators can see the exact content that prompted
  the report, not just "someone reported this user."

On success it returns `201` with the created report row. Auth is required
(`Authorization: Bearer <token>`) — a user reports as themselves, there's no
reporting on someone else's behalf.

## Data model

New `user_reports` table ([reports.ts](../src/db/schema/reports.ts)):

| column             | notes                                                        |
|--------------------|---------------------------------------------------------------|
| `id`               | serial PK                                                     |
| `reporter_id`      | FK → `users.id`, cascades on delete                            |
| `reported_user_id` | FK → `users.id`, cascades on delete                            |
| `post_id`          | FK → `posts.id`, nullable, **set null** (not cascade) on delete |
| `reason`           | text, required                                                 |
| `created_at`       | timestamp                                                      |

Indexed on `reporter_id`, `reported_user_id`, and `post_id` so both "who
reported X" and "what has this user reported" can be queried efficiently
later.

`post_id` is set to `null` rather than cascading when the post is deleted —
a report is evidence, and it should survive even if the reported content is
later removed (e.g. the reported user deletes the review to cover their
tracks).

A DB-level `CHECK` constraint (`reporter_id != reported_user_id`) blocks
self-reports at the data layer, not just in application code.

Migration: [0016_certain_molecule_man.sql](../drizzle/0016_certain_molecule_man.sql).

## Validation rules

Enforced in [reports.service.ts](../src/services/reports.service.ts):

1. **No self-reports** — `reporterId === reportedUserId` is rejected with
   `400`, before any DB check constraint would even fire.
2. **Reported user must exist** — `404` if not.
3. **If `postId` is given, it must belong to the reported user** — `400` if
   the post exists but was written by someone else. This stops a client
   from reporting user A while citing user B's review.
4. **Duplicates are allowed** — a user can report the same person more than
   once (e.g. for two different reviews). There's no unique constraint on
   `(reporter_id, reported_user_id)`.

## What's explicitly out of scope (for now)

- **No fetch/list/search endpoint yet.** There's no admin-role system on
  `users` today — only a static bearer-token route (`/admin/queues`) for the
  job dashboard in `app.ts`. Before building a way to search reports by
  reported user's name, we need to decide whether that reuses the
  `ADMIN_TOKEN` pattern, needs a real admin-role system, or is scoped to
  "reports I've filed" for regular users. Deferred until that's decided.
- **No reason categories.** Matches the mockup as designed — free text only.

## Testing done

Manually verified against a local dev server + Postgres instance (test users
and posts seeded via one-off scripts, then deleted afterward):

- Happy path, with and without `postId` → `201`
- Self-report → `400`
- Reported user doesn't exist → `404`
- Missing `reason` → `400` (zod validation)
- `postId` belongs to a different user than `reportedUserId` → `400`
- Same user reported twice for different reasons → both succeed as separate
  rows
- No `Authorization` header → `401`

No automated tests were added in this pass.
