# Store friend requests as real notifications

**Date:** 2026-10-06

## What changed

Friend requests in the notifications feed used to be a live view over the
`follow_requests` table, merged into the stored notifications at read time
(see [2026-07-23-notifications-feed.md](2026-07-23-notifications-feed.md)).
Because those items had no notification row, the feed gave them a made-up
string id (`"fr_42"`) while every other item had a numeric id. They also
could never be marked read: `readAt` was always `null`.

Each follow request now gets its own row in `notifications`, with type
`friend_request`. That means:

- **`id` is always an integer.** The `fr_` prefix is gone.
- **Friend requests have real read state.** `PATCH /user/notifications/read`
  works on them like any other notification.
- **The feed is a single query** on one table. The two-source merge
  (`lib/merge-notifications.ts`) has been removed.

The `data` payload is unchanged:
`{ followRequestId, senderId, senderName, senderPhotoUrl, status }`.
`followRequestId` is still the id the accept/decline endpoints take.

## Keeping the notification in step with the request

The follow request is still the source of truth. Every place that writes to
it also updates the notification, inside the same database transaction, so
a failure can't leave one changed and the other not:

| Follow-request event | Notification |
|---|---|
| Sent | Row created: `status: pending`, unread |
| Accepted / declined | `data.status` updated, marked read if it wasn't already |
| Re-sent after a decline | Same row reused: `status: pending`, unread again, moved to the top of the feed |
| Withdrawn or unfollowed (request deleted) | Row deleted by the `ON DELETE CASCADE` foreign key |
| Either user deleted | Row deleted by the existing cascades |

A new `notifications.follow_request_id` column carries the link. It is
unique, so there is never more than one notification per request, and the
resend path relies on that as an upsert key. The column is `NULL` for every
other notification type.

Accepting a request used to read the request and then update it in two
separate steps. Now the update itself checks that the request is still
pending, so an accept and a decline that race each other can't both
succeed.

## Behaviour changes worth knowing about

- **`unreadCount` now counts unread rows.** It used to count unread stored
  notifications plus *every pending* friend request. A pending request the
  user has seen but not answered no longer adds to the badge once it has
  been marked read.
- **The sender's name and photo are a snapshot** taken when the request is
  sent (or re-sent). Every other notification type already worked this way.
  Previously they were joined live.
- **Mobile client:** any code that branched on a string id, or skipped
  friend-request items when marking notifications read, can be simplified.
  The response shape is otherwise unchanged.

## Migration

[0071_friend_request_notifications.sql](../drizzle/0071_friend_request_notifications.sql)
adds the column, the foreign key and the unique index, then backfills a row
for every existing follow request so the feed looks the same after deploy.
Pending requests are backfilled as unread, matching the old unread count.
Accepted and declined requests are marked read as of when they were
resolved, since the old count never included them. The backfill is
`ON CONFLICT DO NOTHING`, so running it twice is harmless.

## Out of scope

- The `follow_accepted` notification sent to the requester is unchanged. It
  is still written only when that user's friend-request preference is on,
  and it isn't linked through `follow_request_id`.
- Email and push for friend requests are unchanged.

## Verification

- `friend-request-notifications.integration.test.ts` runs against a real
  Postgres with all migrations applied. It covers send, accept, decline, a
  re-send reusing the same row, withdrawal via the cascade, mark-read, and a
  race between accept and decline where exactly one wins and the
  notification matches the request.
- Backfill SQL run against seeded pending, accepted and declined requests.
  It produced the expected rows, `read_at` and status, and a second run
  inserted nothing.
