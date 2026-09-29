# Accepted follow requests and new recommendations now appear in notifications

**Date:** 2026-09-28

## What changed

Every notification that reaches a phone now also appears in the in-app list
(`GET /api/v1/user/notifications`). Two were missing:

| Event | Push | In-app list before | Now |
|---|---|---|---|
| Your follow request was accepted | ✅ | ❌ | ✅ `follow_accepted` |
| A new book recommendation | ✅ | ❌ | ✅ `new_recommendation` |

Both are stored rows in `notifications`, so they have a numeric `id`, count
toward `unreadCount`, and can be marked read with `PATCH /user/notifications/read`.

`data` shapes:

```json
{ "type": "follow_accepted",
  "data": { "followRequestId": 16, "accepterId": 87, "accepterName": "Kofi Mensah", "accepterPhotoUrl": null } }

{ "type": "new_recommendation",
  "data": { "bookId": 48213, "bookTitle": "Homegoing", "bookAuthor": "Yaa Gyasi", "bookCoverUrl": null } }
```

## Why

A reader got "Friend request accepted" on their phone and found nothing in
the app. The list is built from two sources: stored rows (likes, comments,
group invites) and a live view of follow requests sent *to* the reader. An
acceptance changes a request the reader *sent*, which neither source looked
at, so it only ever existed as a push. Recommendations were never written to
the list at all.

## Decisions

- **Stored, not a second live view.** Accepted requests could have been read
  live from `follow_requests` where the reader is the sender, the way incoming
  ones are. That gives no read state: the item would either always count as
  unread or never count at all.
- **Same preferences as the push.** `follow_accepted` is written only when the
  sender has `friendRequests` on; `new_recommendation` only reaches users with
  `newBookSuggestions` on (both callers already check it). Turning a category
  off removes it everywhere, as with likes, comments and group invites.
- **No database migration.** `notifications.type` is a `varchar`; the list of
  types is a TypeScript constant only.

## Out of scope

- **No backfill.** Acceptances and recommendations from before this change are
  not in anyone's list. They could be backfilled from `follow_requests`
  (accepted, using `updated_at`) and `recommendation_email_log`, but they'd
  arrive as a burst of unread items.
- The OpenAPI `Notification` schema still describes fields (`actor`, `postId`,
  `read`) that the endpoint doesn't return; only the type list and the new
  `data` shapes were documented here.

## Verified

- `merge-notifications.test.ts` covers both new types passing through with
  their `data` and read state.
- End to end against a local database with the real app: A requests B, B
  accepts, A's list shows `follow_accepted` with `unreadCount: 1`, and marking
  it read drops that to 0. The email and push jobs this queued for the
  throwaway users were removed before anything could send them.
