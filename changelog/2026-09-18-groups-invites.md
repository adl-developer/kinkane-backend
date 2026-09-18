# Book clubs: inviting friends, and private clubs becoming usable

**Date:** 2026-09-18

## What changed

Members can now invite their friends to a book club, and the people invited can
accept or decline. This is what makes private clubs work at all — until now a
private club could only ever have the one person who created it.

Club owners can also remove someone, whether they had joined or were still
holding an unanswered invitation.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/groups/:groupId/invitable-friends` | The friend picker. Excludes anyone already in or already invited. |
| `POST` | `/api/v1/groups/:groupId/invites` | Invite up to 50 at once. 30 requests/hour. |
| `POST` | `/api/v1/groups/:groupId/invites/accept` | Returns the club's new member count. |
| `POST` | `/api/v1/groups/:groupId/invites/decline` | |
| `DELETE` | `/api/v1/groups/:groupId/members/:userId` | Owner only. Removes a member or withdraws an invitation. |

**Invitations do not notify anyone yet.** The person invited sees it when they
next open the club. Notifications are the next change.

## Non-obvious decisions

**Any member can invite, not just the owner.** The design puts "+ Invite
friends" on the plain-member view, and the alternative leaves every private
club depending on one person to grow. An invitee who has not accepted yet
cannot invite onward — otherwise an invitation would be transitively a
membership, and one person let in could populate a club before deciding to join
it themselves.

**Inviting is partial-success, not all-or-nothing.** The picker may offer three
friends and one of them may have joined in the intervening minute. Unusable ids
come back individually with a reason — `self`, `not_a_friend`,
`already_member`, `already_invited` — rather than failing the batch and losing
the other two. A request where *every* id was skipped is still a success: it
was understood and acted on, and the reasons are the answer.

**Friendship is checked on the server even though the picker only offers
friends.** A non-friend id means a stale client or someone probing, and neither
should be able to push an invitation at a stranger.

**"Friend" means an accepted follow in either direction.** That matches the
friend count already shown on a profile. The narrower reading — only people you
follow — would hide someone who followed you first, which is not how "Invite
your friends on Kinkane" reads.

**Declining deletes the invitation rather than marking it declined.** This is a
deliberate difference from follow requests, which keep declined rows and revive
them. Nothing in the design reads a declined state, and keeping the row would
make every future re-invitation an update-or-insert against the unique index
instead of a plain insert. **So someone can be re-invited after declining** —
the rate limit is what keeps that from becoming a nuisance, which is where that
concern belongs.

**Accepting or declining twice is a 404, and so is acting with no invitation at
all.** The response deliberately does not distinguish "never invited" from
"already handled"; a different code for each would report whether an invitation
once existed.

**Removing someone never touches the follow graph.** Club membership and
following are independent, so removing a member must not unfollow them. This is
worth stating plainly because the confirmation dialog in the design reads
"Unfollow Theodore Stevens?" — copy carried over from the follow flow. The
behaviour here is correct; **the dialog needs rewording.**

**One endpoint removes both members and pending invitations.** The owner is
severing the same link either way. The member count only moves when the row
removed was an actual membership — withdrawing an invitation leaves it alone,
because an invitation was never counted.

## Verification

`npm test` — 931 tests across 65 files, 11 of them new, covering who may invite,
who may act on an invitation, and the compiled SQL for the friendship condition
(that it matches both directions, counts only accepted follows, and is an
EXISTS rather than a join, which would return a mutual friend twice and render
as a duplicate checkbox).

The whole lifecycle was also exercised against a real database: a friend who
followed the owner and a friend the owner followed both appeared in the picker
while a stranger did not; inviting a mixed batch returned the right skip reason
for each; an invitee was refused both the member list and inviting onward;
accepting moved the count by one and declining left it alone; re-inviting after
a decline worked; a non-owner removing someone got a 404; withdrawing an
invitation left the count alone while removing a member decremented it; and the
accepted follows between all parties were still intact afterwards.

## Out of scope

Notifying the person invited (next change), group search inside Community, and
Report Group. There is still no ownership transfer, which is why an owner
cannot leave or be removed.
