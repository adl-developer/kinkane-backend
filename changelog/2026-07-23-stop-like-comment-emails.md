# Stop emailing users about post likes and comments

**Date:** 2026-07-23

## What changed

`post-like` and `post-comment` no longer send an email. Push notifications
and the in-app notifications feed (added earlier the same day — see
[2026-07-23-notifications-feed.md](2026-07-23-notifications-feed.md)) are
unaffected: a like or comment still shows up as a push alert and in
`GET /api/v1/user/notifications`, it just no longer also lands an email.

Both channels were previously gated by the same `likes`/`comments`
preference toggle and fired in the same `Promise.all` in
`notifyPostLike`/`notifyPostComment` in
[community.service.ts](../src/services/community.service.ts) — the
`enqueueEmail('post-like'/'post-comment', ...)` calls were removed, leaving
`enqueuePush` and the `notifications` table insert.

The recipient `email`/`name` lookup that only existed to populate that email
was removed too, rather than left dead — `posts.userId` already cascades
from `users.id`, so the post existing already guarantees the recipient
exists; there was nothing left needing that query.

## What's explicitly out of scope (for now)

The `post-like`/`post-comment` entries in `EmailJobMap`
([lib/email-queue.ts](../src/lib/email-queue.ts)) and their templates in
`emails/index.ts` were left in place rather than deleted — they're unused
now but low-cost to keep in case email for these events comes back later.

## Testing done

- `npx tsc --noEmit` and `npx vitest run` — clean.
- Manual run against the local dev Postgres instance: created a real post,
  had one user like + comment on another user's post, confirmed via
  `bullEmailQueue.getJobCounts()` that the email queue's job count didn't
  change, and confirmed both events still appear in
  `notificationsService.list(...)`. Cleaned up test rows afterward.
