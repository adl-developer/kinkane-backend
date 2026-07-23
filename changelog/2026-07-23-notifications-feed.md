# Add an in-app notifications feed

**Date:** 2026-07-23

## What changed

There was previously no way to fetch "all of a user's notifications" — the
app only had `/user/notification-preferences` (the on/off toggles) and a
fire-and-forget email/push pipeline with nothing persisted. This adds a real
feed backend for the Notifications screen in the app (likes, comments, and
friend requests).

New endpoints:

```
GET /api/v1/user/notifications?limit=20&offset=0
PATCH /api/v1/user/notifications/read     body: { ids: number[] }
```

`GET` returns:

```json
{
  "notifications": [
    { "id": "fr_482", "type": "friend_request", "createdAt": "...", "readAt": null,
      "data": { "followRequestId": 482, "senderId": 391, "senderName": "...",
                 "senderPhotoUrl": "...", "status": "pending" } },
    { "id": 1042, "type": "post_like", "createdAt": "...", "readAt": null,
      "data": { "postId": 8831, "likerId": 205, "likerName": "...", "likerPhotoUrl": "...",
                 "bookId": 552, "bookTitle": "...", "bookAuthor": "...", "bookCoverUrl": "..." } },
    { "id": 1039, "type": "post_comment", "createdAt": "...", "readAt": null,
      "data": { "postId": 8831, "commentId": 3390, "commenterId": 391, "commenterName": "...",
                 "commenterPhotoUrl": "...", "commentPreview": "...", "bookId": 552,
                 "bookTitle": "...", "bookAuthor": "...", "bookCoverUrl": "..." } }
  ],
  "total": 3,
  "unreadCount": 3,
  "limit": 20,
  "offset": 0
}
```

## Data model

New `notifications` table ([notifications.ts](../src/db/schema/notifications.ts)):
`id`, `user_id` (FK, cascades), `type`, `data` (jsonb), `read_at`, `created_at`.
Indexed on `(user_id, created_at)` for the feed query and `(user_id, read_at)`
for the unread count.

`type` + a jsonb `data` blob rather than a rigid column set, because the
payload already needed to carry display fields (names, avatars, book covers)
that differ per notification type — same shape as the existing
`PushJobMap`/`EmailJobMap` payloads in `lib/push-queue.ts` /
`lib/email-queue.ts`, just persisted.

Migration: [0022_shiny_gateway.sql](../drizzle/0022_shiny_gateway.sql).

## Friend requests are a live view, not a persisted row

`friend_request` items are **not** written into `notifications`. They're
read directly off `follow_requests` (`receiverId = userId`) at request time,
because that table is already the source of truth for
pending/accepted/declined state, and the Accept/Delete actions in the app
call the existing `PATCH /users/follow-requests/:requestId/accept|decline`
endpoints — those operate on `follow_requests.id`, not a notification id.
Persisting a duplicate row risked it drifting out of sync with the real
request state.

Because of that, friend-request items get a synthesized `id` (`fr_<id>`)
instead of a real `notifications.id`, and always carry `readAt: null` — read
state for these isn't tracked separately from Accept/Decline.

The merge — persisted rows sorted against the live `follow_requests` rows —
is done in application code (`mergeNotifications` in
[lib/merge-notifications.ts](../src/lib/merge-notifications.ts)) rather than
a SQL `UNION`, since the two sources don't share a column shape. Both
sources are overfetched up to `offset + limit`, merged, sorted by
`createdAt` descending, then sliced to the requested page.

## Where rows get written

`community.service.ts`'s existing `notifyPostLike` / `notifyPostComment`
(already firing email + push, gated by the same
`notificationPreferencesService.isEnabled` check) now also insert a
`notifications` row in the same `Promise.all`. Both were extended to also
fetch/pass through `bookId`, `bookCoverUrl`, the primary author name (same
`bookContributors` A01 lookup pattern used in
`recommendation-notifications.service.ts`), and the actor's `photoUrl`, so
the feed row has everything the UI needs without an extra round-trip.

## What's explicitly out of scope (for now)

- **`rate_review_reminder` is not wired up.** The mockup for this feed shows
  a "Remember to leave a review" card, but nothing in the backend currently
  triggers that notification type — `rateReviewReminders` is a preference
  toggle and an email template exist, but there's no cron/trigger that
  detects "finished reading, no review yet" and fires it. Confirmed with the
  requester this is deliberately deferred rather than silently faked.
- **No pruning/retention job.** Rows accumulate indefinitely; a cleanup cron
  can be added later if table size becomes a concern.

## Testing done

- `npx tsc --noEmit` — clean.
- Unit tests for the pure merge/sort/paginate logic in
  `src/__tests__/merge-notifications.test.ts` (14 cases: interleaving,
  id-prefixing, data shape mapping, limit/offset slicing, empty inputs).
  There's no existing DB-mock convention in this repo (the only prior test
  file, `dedupe.test.ts`, tests pure logic), so the DB-touching parts
  (`notifications.service.ts`, the `community.service.ts` call sites) were
  verified manually instead of adding a new mocking pattern.
- Manual end-to-end run against the local dev Postgres instance: applied
  migration 0022, created a real post, had one user like + comment on
  another user's post and send them a follow request, confirmed all three
  notification types appear in `GET`'s response with correct `data` shapes
  and sort order, confirmed `likePost`'s `likes: false` preference correctly
  suppressed a `post_like` notification for a user who'd disabled it,
  confirmed `PATCH /read` flips `readAt` and decrements `unreadCount`, then
  cleaned up all test rows.
