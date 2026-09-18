# Making the moderation queue safe for a console that has not caught up

**Date:** 2026-09-18

## What changed

Reports can now be filed against a group as well as a person, which means the
moderation queue returns rows with no reported *person* attached. Anything
reading the queue and expecting a person on every row would break the first time
someone reports a group.

Two additions make that landable without a rewrite of the console:

- **`?targetType=user`** restricts the queue to reports about people — exactly
  the rows, and exactly the shape, it returned before groups were reportable. A
  console that is not ready for group reports can pass this and carry on
  unchanged while the real update is written.
- **`targetName`** carries whichever target the report is about, person or
  group. A row can be labelled from that one field without branching on
  `targetType` or reaching into `reportedUser`, which is null on group reports.

The filter already existed in the service but was never accepted from the query
string, so it could not actually be used. That is now wired up.

## Still true, and still needs the console updated

`reportedUser` is null on a group report, and no server-side change makes that
untrue — it is what the feature means. `targetType=user` is a stopgap, not a
fix: while it is applied, **group reports are invisible to moderators**. The
console needs to handle both kinds before group reporting is much use.

`reportedBy` is *not* nullable, despite an earlier version of this work typing it
that way. A reporter always exists; only an internal join workaround made it look
optional. Keeping it non-null leaves exactly one genuine null to handle.

## Verification

`npm test` — 943 tests across 66 files. `npm run test:endpoints` — 6 passing,
now with a real user id filled into `:userId`, so the routes that take one are
exercised against a row that exists rather than only against a missing id.

Checked against a real database: a group report and a user report both appear
unfiltered, with `targetName` populated from the right side in each case and
`reportedUser` null on the group one; `?targetType=user` returns only the user
report, and every row it returns carries a `reportedUser`.
