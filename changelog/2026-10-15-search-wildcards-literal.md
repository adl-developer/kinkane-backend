# Searching for % or _ no longer returns everyone

## What changed

People search, group search (the Community "Groups" tab, Explore's Groups toggle
and `GET /groups?q`) and the friend picker in a group's invite screen built
their `ILIKE` patterns straight from the query. `%` and `_` are wildcards in
`ILIKE`, so searching `%%%` returned every user or every group, and `___`
returned every name of three or more characters, in an arbitrary order.

The query is now passed through `escapeLike` before it goes into a pattern, so
`%` and `_` match only themselves: `100%` finds "100% Fiction" and nothing else.
Post search got the same fix with post-text search
(`2026-10-15-community-search-post-text.md`).

## Not changed

- The `@handle` username search already escaped, so it is unchanged.
- **Book and author search in `books.service.ts` still build patterns the same
  unescaped way.** That's a separate surface (Explore, typeahead) with its own
  index-matching constraints, so it was left out of this change.
- No API or response shape change.

## Verification

- New `community-search-wildcards.integration.test.ts`: `%%%` and `___` return
  none of the test's users or groups, and `100%` still finds the user and the
  group whose names contain it. Both wildcard tests fail when the escape is
  removed, so they do catch the bug.
- A unit test in `group-invite.test.ts` checks that the friend picker's
  parameters arrive escaped.
- Full unit (1525), integration (179) and endpoint contract (31) suites pass.
