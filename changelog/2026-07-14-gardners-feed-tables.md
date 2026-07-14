# Add database tables for the Gardners Books wholesaler feed ingestion

**Date:** 2026-07-14
**Commit:** _pending — added in a follow-up commit once the hash is known_

## What changed

`onix_ingester` has spent the last several sessions building an SFTP/FTP
ingestion pipeline that pulls physical-book catalogue data directly from
Gardners Books (Kinkane's UK wholesaler) — replacing the old manual-upload
step for ONIX files. That work introduced 6 new tables to store the
wholesaler's price, stock, promotions, and market-restriction data. This
change adds those tables to `server`'s schema and migration history, which
is where migrations actually run in this project (see "why" below).

New tables ([schema files](../src/db/schema/)):

| Table | Purpose |
|---|---|
| `gardners_fetch_log` | Idempotency/progress tracker — one row per remote file fetched from Gardners, keyed on `(feed, remote_path)` |
| `gardners_stock` | Current price + stock quantity per ISBN13, written by both the daily Bespoke Inventory feed and the hourly Avail13 feed |
| `gardners_promotions` | Daily promotional pricing (full replace) |
| `gardners_firm_sale` | ISBNs that are firm-sale only, no returns (weekly full replace, ~6M rows) |
| `gardners_isbn_slips` | Old ISBN → new ISBN redirects for replaced editions (weekly full replace) |
| `gardners_market_restrictions` + `gardners_regions` | Per-region sellability flags and a small region-code lookup |

All of the ISBN-keyed tables have a nullable `book_id` FK to `books` (`ON
DELETE SET NULL`) rather than a required one — Gardners' inventory/pricing
data routinely arrives for ISBNs that don't have a matching `books` row yet
(ONIX ingestion runs on its own weekly cadence), so `onix_ingester` backfills
`book_id` after the fact rather than blocking on it.

Migration: [0017_absent_jack_power.sql](../drizzle/0017_absent_jack_power.sql).

## Why this lives here, not in onix_ingester

`onix_ingester` used to own its own migrations (`drizzle.config.ts`,
`db:generate`/`db:migrate`), but that responsibility moved to `server` back
in May 2026 — `onix_ingester`'s own migration tooling was removed at the
time. `server`'s `render.yaml` runs `npm run db:init` (extensions + migrate +
setup) as a `preDeployCommand` on every deploy; `onix_ingester`'s
`render.yaml` has no migration step at all.

The Gardners tables were initially added via a hand-written SQL file living
in `onix_ingester/src/db/migrations/` (following what turned out to be a
stale, pre-May convention), and only ever got applied to a local dev
database by manually executing that file — it was never going to run on a
real deploy. This change corrects that: the schema now lives in `server`,
tracked by drizzle-kit like everything else, and gets applied automatically
via the existing `db:init` deploy step. The orphaned file in
`onix_ingester` is being removed in that repo as part of the same effort.

Also fixed a stale comment on [books.ts](../src/db/schema/books.ts) that
said the opposite of the current convention ("owned and migrated by
onix_ingester") — leftover from before the May policy change, never
updated.

## What's explicitly out of scope

- **No new API endpoints or business logic in `server` itself.** These
  tables are populated and read exclusively by `onix_ingester`; `server`
  just owns the migration. Whether/how the storefront API should surface
  stock levels, promotions, or market restrictions is a separate decision
  for later.
- **No aggregated "is this book sellable in Ghana" column.** The market
  restriction data is stored as raw per-`(isbn13, region)` facts; Ghana's
  specific region code wasn't confirmed in the data pulled so far, so that
  aggregation is deferred.

## Testing done

- `tsc --noEmit` clean after adding the 6 schema files and updating the
  barrel export.
- Generated the migration with `npm run db:generate` and confirmed it only
  contains the intended 7 new objects (2 enums + tables) — no unrelated
  diffs.
- **Ran the entire migration history (0000 → 0017) against a freshly
  created, empty database** and confirmed all 7 tables, their columns, and
  all 4 `book_id` foreign keys were created correctly.
- Confirmed `db:migrate` also runs cleanly against the existing local dev
  database, where these tables already existed (created by the old
  hand-written script) — drizzle-kit's generated SQL uses `IF NOT EXISTS`
  and exception-swallowing for every statement except the two `CREATE TYPE`
  enum statements (Postgres has no `IF NOT EXISTS` for `CREATE TYPE`), which
  needed the local database's `drizzle.__drizzle_migrations` tracking table
  manually reconciled (a one-time fix, only needed because this specific
  local database had the tables from before this migration existed — a
  fresh database or one that's never seen the old hand-written script needs
  no such step).
