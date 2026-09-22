# The book clubs someone else is in

**Date:** 2026-09-22

## What changed

A reader's profile can now show the book clubs they belong to, the same way it
already shows their shelf, their followers and who they follow. Until now
`GET /api/v1/groups/mine` answered that question for yourself and nothing
answered it for anyone else.

### Endpoint

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/users/:userId/groups` | Most recently joined first. Paginated (`limit` up to 50, `offset`). |

The response is the same shape as `/api/v1/groups/mine` —
`{ groups, total, limit, offset }` — so a client can render both sections with
one component. Pending invitations are excluded on both: an invitation is not a
membership, and this list is a statement about where someone actually is.

Calling it with your own id is allowed and returns everything, identical to
`/groups/mine`. No Kinkané Plus required; only *creating* a club is gated.

## Non-obvious decisions

**A private club only appears if the viewer is in it too.** This is the whole
security question of the change. Reading someone's club list is the member list
read sideways: "is Theo in this club" is exactly what
`GET /groups/:groupId/members` answers, and there a private club's roster is
members-only. Without a filter, walking profiles one at a time would rebuild the
roster of every private club in the app — the rule would still be enforced at
the endpoint that states it, and routed around everywhere else. So the same line
is drawn here, which means this endpoint can never reveal a membership the
member list would not.

Public clubs need no test at all: their roster is already open to anyone signed
in, so naming their members from a profile reveals nothing new. That is why
there is no follower-or-friend gate on this endpoint the way there is on the
follower list — the visibility of each club, not the relationship between the
two readers, is what decides.

**An invitation does not unlock the sideways read either.** The filter counts
active memberships only, matching `decideMembershipAction('view_members')`,
where an invitee to a private club is refused the roster like any other
non-member.

**`total` counts the filtered set, not every membership.** It has to, or the
client would page past the end of what it can see — and the number itself would
leak how many private clubs it was not allowed to name. The consequence worth
knowing: two people looking at the same profile can legitimately see different
totals, and that is correct rather than a caching bug.

**A missing user is a 404, not an empty page.** "This reader has not joined
anything" and "there is no such reader" are different answers, and returning the
first for the second would render a real but empty profile for an id that does
not exist.

**Your own list skips the filter entirely** rather than running it and having
every row pass. Every club you are in satisfies the condition by definition, so
evaluating it could only cost a subquery and never change a row — this keeps
`/groups/mine`, the hotter of the two paths, exactly as fast as it was.

**The filter is `id IN (subquery)`, not a correlated `EXISTS`.** Same reasoning
as `friendOfCondition` next to it: the viewer's own memberships are a small set
read straight off `idx_group_memberships_user_status`, which the planner can
gather once instead of re-probing for every candidate row.

## Also worth knowing

The endpoint is mounted under `/users`, not `/groups`, because it answers a
question about a person — it sits beside `/users/:userId/followers` and
`/users/:userId/books`. The handler still lives on the groups controller and the
query on the groups service, since that is where every other group rule lives.

The one change to existing behaviour: the `total` query behind `/groups/mine`
now joins `groups`, because the filter reads `groups.privacy` and both queries
must apply the same condition or `total` would over-count what was returned. The
answer it gives is unchanged.

## Out of scope

No "clubs in common" or mutual-membership hint, no sorting or search on the
list, and no counter on the profile payload — `total` covers it for now. Whether
a reader should be able to hide their clubs the way `shelf_visibility` hides
their shelf is a real question, but it is a settings change with its own column
and migration, not part of this.

## Verification

`npm test` — 985 unit tests across 67 files, 4 of them new: the visibility
condition is compiled to SQL and pinned the way group search is, including the
one substitution that would silently invert it (filtering on the profile's owner
instead of the viewer, which passes a smoke test and protects nothing).
`npm run test:endpoints` — 6 passing, confirming the route is mounted, protected
and does not 5xx.

Beyond that, the whole rule was exercised against a real database. A reader was
put in four clubs — a public one they own, a public one they joined, a private
one they own, a private one they share with a second account — plus a pending
invitation to a fifth. Their own list returned all four and never the invite;
a stranger saw the two public clubs and a `total` of 2; the account sharing the
private club saw three. Paging as a stranger stayed inside the filtered set, and
a request for an id that does not exist returned 404. The endpoint was then
driven over HTTP end to end: 200 with the private club absent, 401 unauthorised,
404 for a missing user, 400 for a non-numeric id and for an out-of-range limit.
