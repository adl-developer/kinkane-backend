# Let people report comments under community posts

**Date:** 2026-10-23

## What changed

A user report (`POST /api/v1/reports`, `targetType: "user"`) can now name a `commentId`, a
comment under a community post, as the thing that prompted it. The admin moderation queue
(`GET /api/v1/admin/reports`) returns that comment's text and the post it sits under, so a
moderator can judge it without looking it up.

Before this, a report could cite a community post (`postId`) or a group book-club comment
(`groupCommentId`), but not an ordinary comment under a post. Abuse in post comments could
only be reported against the person, with no record of which comment was meant.

## Data / API shape

- **Database:** a new nullable `user_reports.comment_id` column. It is a foreign key to
  `comments` with `ON DELETE SET NULL` and an index, added by migration
  `0089_report_post_comments`.
- **Request:** `commentId` is an optional positive integer on user reports only.
- **Admin queue:** each report has a new
  `comment: { id, postId, body } | null`. Mentions in `body` are rendered as @usernames,
  the same as `groupComment`.

## Non-obvious decisions

- **Ownership:** the comment must be by `reportedUserId`. If it isn't, the response is a 400
  rather than a report filed against the wrong person, the same rule as posts and group
  comments.
- **Private posts:** a comment under someone else's private post returns 404, the same as a
  comment that doesn't exist. Without this, anyone could probe comment ids and user ids to
  learn who commented on posts they can't see. The post's own author can still report
  comments on it.
- **One piece of content per report:** naming more than one of `postId`, `commentId` and
  `groupCommentId` is a 400. Before, only `postId` together with `groupCommentId` was
  refused.
- **Deleted comments:** the report survives. `comment` becomes null in the queue, so a
  moderator still sees the complaint and its reason.
- **Blocks:** a block between the reporter and the commenter does not stop the report.
  Being able to report someone you have blocked is the point.

## Out of scope

- The mobile app needs to send `commentId` from the "…" menu on post comments.
- The admin console needs to render the new `comment` field.
- Comments are not report targets of their own. As with posts, a report is filed against
  the comment's author and cites the comment.

## How it was verified

A new integration suite, run against a scratch Postgres, covers:
- filing a report and reading it back from the queue with its text and post
- the wrong author (400)
- someone else's private post (404), and the post author reporting on their own private post (201)
- a post and a comment named together (400)
- a deleted comment, where the report stays and `comment` is null

The typecheck and the full unit suite pass.
