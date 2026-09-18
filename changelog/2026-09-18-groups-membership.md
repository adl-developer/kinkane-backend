# Book clubs: joining, leaving and seeing who is in one

**Date:** 2026-09-18

## What changed

Book clubs can now have more than one person in them. Readers can join a public
club, see who else is in it, and leave again.

Private clubs stay invite-only, and invitations are not built yet — so a private
club still has exactly one member until the next change lands. What private
clubs do now have is a working locked state: a non-member can see the club and
is told they need an invitation, but cannot see the member list or join.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/groups/:groupId/members` | Oldest first, owner at the top. Members-only on a private club. |
| `POST` | `/api/v1/groups/:groupId/join` | Public clubs only. Returns the new member count. |
| `DELETE` | `/api/v1/groups/:groupId/membership` | Leave. The owner cannot. |

None of these require Kinkané Plus. Only *creating* a club is gated — a
membership that needed a subscription would make an invitation useless to the
friend receiving it.

## Non-obvious decisions

**The member list is the only thing "private" actually hides.** A non-member of
a private club can still see its name, image, description, owner and creation
date — that is what the "you need an invite to join" screen shows. So the
roster returns **403, not 404**: a 404 would deny the club exists while the
reader is looking at it. Owner-only actions still 404, because there ownership
is part of the lookup and "not yours" is indistinguishable from "not there".

**An invitee is not a member yet.** They get the same 403 on the roster as a
stranger, and a 409 on joining that tells them to accept the invitation
instead. Letting an invite be overwritten by a plain join would silently lose
who invited them, which is the one piece of information the invitation carries.

**The owner cannot leave.** They get a 400 pointing at deleting the club. There
is no ownership transfer in this version, so an owner walking out would leave
the club with no one able to edit or delete it. 400 rather than 403 because it
is not a permissions problem — there is simply no such move.

**The member count is moved in the same transaction as the membership, never
separately.** The unique (club, member) index is what makes that safe: a second
simultaneous tap conflicts, returns no row, and never reaches the increment.
Verified by firing five concurrent joins from one account — one succeeded, four
were refused, and the count moved by exactly one.

**Leaving uses `GREATEST(count - 1, 0)` rather than a plain decrement.** If the
count ever drifted to zero while a membership still existed, a bare `- 1` would
break the non-negative constraint and trap the member in a club they were
trying to leave. Drift is a data problem to repair; it should not become a
reason to refuse someone their exit.

**The roster's `total` counts memberships directly rather than reading the
stored count.** This is the one place the two numbers can be compared, so a
disagreement surfaces as a visible inconsistency instead of staying hidden.

## Also worth knowing

All the rules above live in one pure function, `decideMembershipAction`, rather
than being spread across the endpoints. There are twenty-four combinations of
action, standing and privacy, and the tests walk them — including the ordering
question of whether a member of a private club is told "already a member" or
"this is private" (the first: the second would send the app down the invite
path for someone already inside).

The plan this came from had one rule wrong: it said an invitee should be
refused the roster of a *public* club, while a total stranger could see it.
That makes an invitation worth less than no invitation, so the implementation
treats roster access as a question of membership and privacy only, and ignores
the invite. Worth knowing if the plan is read later.

## Out of scope

Invitations, removing a member, the friend picker, group-invite notifications
and Report Group. Ownership transfer is not built, which is what makes the
owner unable to leave.

## Verification

`npm test` — 920 tests across 64 files, 14 of them new and covering every
combination of action, standing and privacy. `npm run test:endpoints` — 6
passing.

Beyond the unit tests, the whole surface was exercised against a real database
through the service itself: join, duplicate join, roster, owner-leave refusal,
leave, leave-again, the private-club refusals, and a five-way concurrent join.
The count landed correctly at every step.
