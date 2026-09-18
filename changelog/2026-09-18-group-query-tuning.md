# Making the book club screens hold up as the app grows

**Date:** 2026-09-18

## What changed

No behaviour changes. This is the follow-up to a review of the book club work:
several queries were correct but would get slower as the number of accounts,
clubs and members grows, and this fixes them while the tables are still small
enough that the change is free.

## The invite picker no longer depends on how many accounts exist

Finding a member's friends was written as "look at every user, and for each one
ask whether a follow connects them to me". That reads naturally but the
condition spans two columns — a follow can run either way — so the database
could not use it as a join key and fell back to re-testing the member's follows
against each candidate in turn. The cost therefore grew with the total number
of accounts, on a screen opened every time someone taps "Invite friends".

It now asks the opposite question first: "who are my friends?" — two indexed
lookups combined — and then fetches exactly those people by primary key. The
work is bounded by how many friends the member has, which is the number the
screen is actually about.

The two indexes behind those lookups now also cover the status column, so
"my accepted follows" is answered entirely from the index rather than by
fetching each row to check whether the follow was accepted.

## Clubs stop carrying their search index over the wire

Every club query fetched all columns, including the generated column that backs
search. Nothing reads it — it exists for the database to match against — but it
was being sent to the server and discarded on every list. Measured on a club
with a full-length description it is about 1.5 KB, so roughly 73 KB per page of
fifty. The queries now name the columns they actually use.

## Three more indexes

Browsing clubs is "newest first", and the member list and "your groups" are both
"oldest first" within a club or a person. Each of those was sorting its whole
result to return a page of twenty. All three are now ordered by an index.

The two on the club tables are simple replacements — those tables are new and
empty. The two on the follow table are not: that is the live social graph, so
the replacements are **built before the originals are dropped** and are
deliberately named differently to make that possible. They are also registered
with the concurrent index builder, so a deployed environment builds them without
taking a lock and the migration finds them already present.

## Smaller things from the same review

- Opening a club used two queries to fetch the club and then the viewer's
  membership. It is one query now. The duplication mattered more than the extra
  round trip: the same question was being answered two different ways in one
  file, so a future change to the membership rules could have been made in one
  and missed in the other.
- Notifying a batch of invitees checked each person's notification setting with
  its own query — up to fifty, several of which would also create a defaults row.
  It is one query for the batch now.
- The moderation queue reported who filed a report as possibly absent. It never
  is; only an internal typing workaround made it look that way. Consumers now
  see one genuine null (the reported user, absent on a club report) instead of
  two, one of which was noise.
- The reports route documentation still described only user reports, with no
  mention of clubs. It now covers both, including that the club form rejects a
  request that also names a user rather than ignoring the extra field.
- Inviting someone whose membership row is in the reserved "requested" state
  would have reported them as an existing member. Unreachable today, since
  nothing writes that state, but wrong the moment asking to join is built.

## Verification

`npm test` — 943 tests across 66 files. Four in the invite suite were rewritten:
they had pinned the old query's internals (an EXISTS with an OR), and now pin
the properties that survive the rewrite — that both follow directions are
matched, that only accepted follows count, that a mutual friend cannot appear
twice, and that the condition is a join key rather than a two-column filter.

`npm run test:endpoints` — 6 passing, which is the suite that would catch a
schema change with no migration behind it.

The whole flow was also re-run against a real database after the changes:
bidirectional friendship still resolves, skip reasons are unchanged, a member
who has opted out still receives no notification, accepting still moves the
count by one, search still matches, and no club query returns the search column.
