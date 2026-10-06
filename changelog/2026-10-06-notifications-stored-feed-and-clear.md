# Friend requests in the feed can be marked read, and notifications can be cleared

**Date:** 2026-10-06

## What changed

This is the second of two releases. The first
([2026-10-06-friend-request-notification-sync.md](2026-10-06-friend-request-notification-sync.md))
started writing a stored notification for every friend request without
showing it. This release:

1. **Backfills** a stored notification for every older friend request.
2. **Switches the feed** to read only stored notifications. Friend requests
   are no longer built on the fly.
3. **Adds clearing.** Marking a notification read no longer implies it goes
   away. It stays in the feed until the user clears it.

**Deploy order:** the first release must already be live in production.
Rolling this release back to the first one is safe, because that code skips
the stored friend-request rows.

## What the app sees

- **`id` is always an integer.** The `fr_42` string ids are gone.
- **Friend requests can be marked read** with `PATCH /user/notifications/read`,
  like any other notification. Accepting or declining one also marks it read.
- **`unreadCount` counts notifications not yet marked read.** A pending
  friend request that has been marked read no longer adds to the badge.
  This was a deliberate decision: read means read.
- **The friend-request `data` is unchanged:**
  `{ followRequestId, senderId, senderName, senderPhotoUrl, status }`. The
  status, name and photo are looked up live when the feed loads, so a sender
  who renames themselves or removes their photo shows up correctly.

## Clearing

```
DELETE /api/v1/user/notifications/:id   → 200 { "cleared": 1 }
DELETE /api/v1/user/notifications       → 200 { "cleared": <n> }
```

- **One by id:** removes that notification, read or unread. Returns 404 if
  the id isn't the caller's.
- **All (no id):** removes every notification the caller has, read or
  unread.
- **Exception:** a friend request still waiting for an accept or decline
  can't be cleared. Clearing all skips it. Clearing it by id returns
  `409 { code: "FRIEND_REQUEST_PENDING" }`. Once it's answered it clears like
  anything else. Whether a request is still pending is read from the follow
  request itself, not from the notification's copy of its status.
- **Clearing deletes the row.** If a cleared, declined request is later
  re-sent, it comes back as a fresh unread notification.

## Migration

[0072_friend_request_notifications_backfill.sql](../drizzle/0072_friend_request_notifications_backfill.sql)
inserts a notification for every follow request that doesn't have one yet.
Pending requests are unread, matching the old badge. Accepted and declined
requests are marked read as of when they were resolved, since the old badge
never counted them. Requests the first release already covered are left as
they are, including any read state, and a re-run inserts nothing.

## Removed

`lib/merge-notifications.ts` and its unit tests. They merged the stored rows
with the live friend-request view, which no longer exists.

## Verification

- `friend-request-notifications.integration.test.ts`, against a real
  Postgres with all migrations applied: everything from the first release,
  plus the feed (numeric ids; marking read keeps the item and drops the
  badge), the sender's live name and photo, clearing one (read or unread),
  a 404 for another user's id, a 409 for a pending friend request and
  success once it's answered, clearing all except pending requests (and
  never touching another user's notifications), and a cleared request
  coming back when re-sent.
- Backfill run against seeded pending, accepted and declined requests plus
  one row the first release had already written: the expected rows were
  created, the existing row and its read state were untouched, and a second
  run inserted nothing.
- The endpoint contract suite covers the two new DELETE routes refusing
  anonymous callers.
