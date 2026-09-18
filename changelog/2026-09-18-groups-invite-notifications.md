# Book clubs: telling people they have been invited

**Date:** 2026-09-18

## What changed

Being invited to a book club now actually reaches you. The invitation appears in
your notifications and sends a push, so invitations no longer depend on the
invited person happening to open the club.

A new **Group invites** toggle sits in notification settings alongside friend
requests, comments and likes.

## Non-obvious decisions

**Push and in-app only — never email.** The same policy the existing comment and
like notifications follow. An invitation is worth a badge, not an inbox.

**The toggle is its own preference, not folded into friend requests.** Reusing
that one would mean someone who muted friend requests silently stopped receiving
group invitations, with nothing on screen explaining why.

**It is not part of one-click unsubscribe.** Unsubscribe clears the promotional
group only. A group invitation is a person asking you to join something, not us
marketing at you, so it keeps arriving — the same reasoning that already exempts
friend requests.

**The notification is a stored record, not a live view of the invitation.** This
differs from friend requests, which are synthesized on read from the request
table. That card has to show its current state, so it must be live; an invitation
card says "Amara invited you to Books & Friends", which stays true afterwards.
Accepting or declining leaves the notification in place as history, exactly like
a like or a comment, and it can be marked read like one.

**Group and inviter details are copied into the notification when it is
written**, rather than joined on read — the same approach the like and comment
producers take. The card renders with no join, and still reads correctly if the
club is later renamed or deleted.

**Only genuinely new invitations notify.** Re-inviting someone who already has an
invitation outstanding is silent, so the invite button cannot be used to nag.

**Sending is fire-and-forget.** The invitation is recorded the moment its row
exists; a notification that fails to enqueue is logged and must never undo the
invitation or fail the request.

## Verification

`npm test` — 934 tests across 65 files, 3 new ones covering that a stored
invitation keeps its numeric id and real read state while the synthesized friend
request keeps its string id and null one, that the copied details survive the
merge, and that invitations sort into the feed by time rather than being grouped.

Also exercised against a real database with two friends, one of whom had turned
the preference off: two invitations were sent, exactly one notification was
written, the copied group and inviter details were correct, and re-inviting the
already-invited friend produced no second notification.

## Out of scope

Group search inside Community, and Report Group.
