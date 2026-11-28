# Database queries time out after 30 seconds

## What changed
Every connection in the API's database pool now has a `statement_timeout`. Postgres cancels
any single statement that runs longer than the limit and returns error `57014`. The limit is
`DATABASE_STATEMENT_TIMEOUT_MS`, default `30000`; `0` turns it off.

## Why
On 2026-11-27 the DigitalOcean database CPU spiked. Prod had no statement timeout at all.
`pg_stat_statements` showed author searches, title browses and shop band counts averaging
1.5–6 minutes each. Run alone, the same queries take 6–17 s, so the minutes came from
queries overlapping and slowing each other down, with nothing to cancel them.

## Decisions
- **30 s, not 15 s.** Nearly all legitimate work finishes well under 30 s. The recommendation
  cron's vector searches occasionally take 30–63 s. The cron catches errors per user, so a
  timeout skips and logs that one user rather than failing the run.
- **Set on the app's connection, not with `ALTER ROLE`.** Bulk loads, `db:init`/setup and
  concurrent index builds share the `doadmin` role but use their own clients, so they stay
  uncapped. `onix_ingester` (Gardners feeds, cover sync) also has its own connection and is
  unaffected.
- The existing `SET LOCAL statement_timeout` in the search count probes still overrides the
  pool default for its own transaction.

## Out of scope
This change only caps runaway statements; the slow queries themselves are untouched. Fixes for
those come separately: an index for the author full-text arm, a C-collation index for title
prefixes, and a timeout on shop band counts.

## Verified
- Against the prod database with a 2 s cap: a 3 s `pg_sleep` was cancelled at about 2.1 s
  (`57014`).
- A `SET LOCAL statement_timeout = 5000` transaction let the same 3 s sleep finish, and the
  connection reverted to the pool default afterwards.
- With nothing set, the limit is 30000.
- Typecheck clean; unit suite 1681/1681.
