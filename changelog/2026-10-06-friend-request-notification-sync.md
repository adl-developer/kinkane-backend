# Start recording friend requests as notifications (not shown yet)

**Date:** 2026-10-06

## What changed

This is the first of two releases that turn friend requests into real,
stored notifications. Today the feed builds friend requests on the fly from
the `follow_requests` table. That gives them a string id (`"fr_42"`) unlike
every other item, and they can't be marked read.

From this release, every follow request also writes a `friend_request` row
to `notifications`, and that row is kept in step with the request. **The
feed doesn't read these rows yet**: it still builds friend requests the old
way and leaves the new rows out. Nothing changes for the app in this release.

## Why two releases

Render runs migrations before the new code starts, and the old code keeps
serving until the new code is healthy. Backfilling the rows and switching
the feed in one release would show every friend request twice in that
window, because the old code would read both the stored rows and its live
view. A rollback would leave them doubled until the next deploy.

Splitting the change avoids both:

- **This release** writes rows only for new activity, and its feed skips
  them. The migration adds no rows, so the old code serving during the
  deploy has nothing extra to show.
- **The next release** backfills older requests and switches the feed to the
  stored rows. If that release is rolled back to this one, this code skips
  the stored rows, so nothing is doubled.

One case still needs a manual step. The code *before* this release reads
every notifications row, so if this release itself is rolled back, requests
sent while it was live show twice. Nothing else reads these rows yet, so the
fix is to delete them as part of the rollback:

```sql
DELETE FROM notifications WHERE type = 'friend_request';
```

The next release's backfill recreates them. The same doubling can show for
a few seconds while old and new instances overlap during this deploy, and
only for requests sent in those seconds.

**This release must be live in production before the next one is merged.**

## Keeping the notification in step with the request

Each write below happens in the same database transaction as the
follow-request change:

| Follow-request event | Notification |
|---|---|
| Sent | Row created: `status: pending`, unread |
| Accepted / declined | `data.status` updated, marked read if it wasn't already |
| Re-sent after a decline | Same row reused: `status: pending`, unread again, moved to the top |
| Withdrawn or unfollowed | Row deleted by the `ON DELETE CASCADE` foreign key |

`notifications.follow_request_id` links the two. It's unique, so there's
never more than one notification per request.

## Race fixes that came with it

- **Accept** used to read the request and then update it in two separate
  steps. Now the update itself checks the request is still pending, so an
  accept and a decline that race each other can't both succeed.
- **Re-send** now only updates a request that's still `declined`. Before, a
  withdraw landing between the "can I re-send?" check and the write updated
  nothing and still reported success. With the new notification write that
  would have become a 500 (foreign key violation). It now returns a 409
  asking the user to try again.

## Index build

`idx_notifications_follow_request_id` is also registered in
`build-concurrent-indexes.ts`, matching how 0057 and 0060 handled indexes on
new columns. On this deploy the column doesn't exist until the migration
runs, so the migration builds the index itself, over a column that's NULL
in every row. Any later rebuild takes the lock-free concurrent path.

## Also in this release

- The pre-commit hook now runs the integration suites when
  `TEST_DATABASE_URL` is set, and warns when it isn't. Before, nothing ran
  them automatically.
- The transaction type used by services is exported once from `src/db`
  instead of being redeclared in each service.

## Verification

- `friend-request-notifications.integration.test.ts`, against a real
  Postgres with all migrations applied, covers: send, accept, decline,
  re-send reusing the same row, withdrawal via the cascade, an accept racing
  a decline (exactly one wins and the notification matches), a re-send
  racing a withdraw (a 4xx and never an orphaned notification), and the
  feed still listing each request once.
- The concurrent-index entry was checked on both paths: "already built"
  after the migration, and a concurrent rebuild after the index was dropped.
