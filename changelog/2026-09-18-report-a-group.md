# Reporting a book club

**Date:** 2026-09-18

## What changed

Readers can report a book club, not just a person. `POST /api/v1/reports` now
takes a `targetType` of `user` or `group`, and group reports appear in the
moderation queue alongside the rest.

Clients written before this keep working untouched: `targetType` defaults to
`user`, so a request that omits it behaves exactly as it always did.

## Non-obvious decisions

**A discriminator, not a second optional id.** The alternative — adding a
nullable `groupId` and inferring the kind from whichever column happens to be
filled — cannot express "this is a group report" in the data, so the database
could not enforce the shape and the moderation queue could not filter by kind.

**The group arm of the shape constraint does not require a group to be
present.** A user report must name a user and no group; a group report must
name no user, but is allowed to name no group either. That looks like a gap and
is deliberate: deleting a reported group nulls the reference rather than erasing
the complaint, and requiring it to be present would make deleting a reported
group fail on the constraint. A complaint has to be able to outlive the thing it
was filed against — the same behaviour a report about a deleted post already
had.

**Naming both a group and a user is rejected rather than interpreted.** By
default the validation library quietly drops fields that do not belong, which
would have filed such a request as a group report — a guess at an ambiguous
intent. The group branch is strict so this returns a clear error instead. The
user branch stays permissive, because clients already in the wild post to it.

**Blacklisting is refused on a group report.** There is no account behind one.
Beyond returning a clear error, this matters because blacklisting also closes
every other pending report against that person — running it with no person
could have closed unrelated reports in a single sweep.

**One shared `R###` reference series for both kinds.** The identifier is only
ever shown next to the report it belongs to, and two series would produce
colliding numbers that mean different things, so a moderator told "check R012"
would have to ask which one.

**The moderation queue's joins are now outer joins.** This is the change most
likely to break something invisibly: a group report has no reported user, and
the previous inner join would have dropped every group report out of the queue
with no error at all — moderators would simply never have seen them.

One incidental detail worth recording: the reporter is now also joined
outwards, though a reporter always exists. The query builder cannot infer the
result type of a query mixing inner and outer joins and silently collapses it,
so this is a typing accommodation. It returns exactly the same rows.

## Verification

`npm test` — 942 tests across 66 files. Reports had **no test file at all**
before this; there are now 8, covering the back-compatible default, rejection of
mixed targets, the missing-target cases, and that the queue query uses outer
joins.

Also exercised against a real database: a group report and a user report were
filed and both appeared in the queue with the right target resolved and the
other side null; filtering by kind worked; reporting a group that does not exist
returned 404; blacklisting from a group report was refused; and after deleting
the reported group the report survived with its reference nulled and no
constraint violation.

## Out of scope

Moderators can resolve or dismiss a group report but cannot delete the group
from the console. That needs its own decision about who may remove someone
else's club.
