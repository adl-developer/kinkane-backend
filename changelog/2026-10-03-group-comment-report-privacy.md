# Stop comment reports revealing who wrote what in private book clubs

**Date:** 2026-10-03

## What changed

Reporting a book-club comment (`POST /api/v1/reports` with `groupCommentId`) now checks that the
reporter can see the club the comment is in. If they can't, because it's a private club they
aren't an active member of, the response is the same `404 Comment not found` as for a comment
that doesn't exist.

## Why

Before this change the endpoint only checked that the comment existed and that `reportedUserId`
wrote it. Anyone signed in could probe it from outside a private club:

| Request | Old answer |
|---|---|
| comment N doesn't exist | 404 |
| comment N exists, but X didn't write it | 400 "Comment does not belong to the reported user" |
| comment N exists and X wrote it | 201, and a report is filed |

By walking comment ids and user ids, a stranger could work out who said what in clubs they had
no access to, and every hit put a junk report into the moderation queue.

## Behaviour now

- **Who can see a comment:** the rule is the same one as the club's bookshelf (`canSeeShelf`):
  - anyone signed in, for a public club
  - active members and the owner, for a private one
  - not an invitee who hasn't accepted yet, and not an ex-member
- **Hidden comments:** if the reporter can't see the comment, they get 404 before any
  authorship check, so no answer depends on who wrote it.
- **Visible comments:** reporters who can see the comment get the same answers as before,
  including the 400 when the comment isn't by `reportedUserId`.
- **Other reports:** plain user reports, post reports and group reports are unchanged.

## How it was verified

An end-to-end run against a throwaway local Postgres:
- A stranger, an invitee and an ex-member of a private club all get 404, for both the right
  and the wrong author, identical to a missing comment.
- The owner, members, and anyone reporting a comment in a public club still get 201.
- No report rows are written for the refused requests.

The full group-bookshelf edge suite (127 checks) and the unit suite (1,153 tests) still pass.
