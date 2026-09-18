# Book clubs now turn up in search

**Date:** 2026-09-18

## What changed

Searching in Community now returns book clubs alongside people and posts.
`GET /api/v1/community/search` takes `filter=groups`, and every response now
carries a `groups` array.

This backs two screens: the **Groups** tab in Community, and the third option on
the Explore `Books | Authors | Groups` toggle. Both call the same endpoint.

## Non-obvious decisions

**One ranking formula, defined once.** Groups are matched and ordered by the
same four widening tiers as people and posts — name prefix, word prefix,
near-spelling, then full text across name and description. The builders live in
the groups service, where the standalone `GET /groups?q` search already uses
them, so there is a single definition rather than two that drift. Without that,
the same query would order differently depending on which tab you were looking
at, which reads as a bug and is very hard to pin down.

**The Explore toggle is served from here rather than from book search.** That
toggle is already three separate client calls; pointing the third at community
search costs the client a base URL and the server nothing. Duplicating the
formula into the book search surface would mean two copies against one index.

**Private clubs are included.** They are unjoinable, not secret: the design
shows a non-member a private club's name, owner and description, and that
"you need an invite to join" screen would be unreachable for anyone who had not
already been sent a link. Only the member list and the ability to join are
withheld.

**Groups are fetched in parallel with the other kinds**, not after them, so
`filter=all` costs one more concurrent query rather than an extra round trip.

**The response is additive.** Existing clients keep working; `groups` and
`total.groups` are simply new keys. Note that the API documentation previously
described `total` as a single number, which was wrong — it has always been a
per-kind object. That is now corrected.

## Verification

`npm test` — 934 tests across 65 files. The ranking itself is already pinned by
the group search tests added with `GET /groups?q`, which assert on the compiled
SQL: that full text only joins in from three characters, that the ordering has
one branch per matching tier, and that it uses the expression the trigram index
can actually serve.

Also exercised against a real database: `filter=groups` returned both a public
and a private club ranked correctly with per-kind totals; `filter=all` included
them alongside the other kinds; and `filter=users` still returned an empty
`groups` array rather than omitting the key.

## Out of scope

Report Group. Blending books, authors and groups into a single ranked list is
also not done — there is no principled scale on which a book title match and a
club name match compare, so the three stay separate client-side tabs.
