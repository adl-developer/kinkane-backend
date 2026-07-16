# Fix broken ONIX ingestion caused by a stale ingestion_chunks column

**Date:** 2026-07-16

## What changed

`ingestion_chunks.data` (jsonb) is replaced with `ingestion_chunks.data_key`
(varchar(500)). Migration:
[0020_fix_ingestion_chunks_data_key.sql](../drizzle/0020_fix_ingestion_chunks_data_key.sql).

## Why

`onix_ingester`'s `file.worker.ts`/`chunk.worker.ts` were rewritten at some
point to store each chunk's parsed book payload in R2 (referenced by
`dataKey`) instead of inline in the database, keeping large payloads out of
Postgres and Redis. `server`'s copy of the `ingestion_chunks` schema was
never updated to match — it still had the old `data` jsonb column and no
`data_key` column at all.

This was silent until someone actually ran a real ONIX ingestion against a
database migrated from `server`'s schema: `file.worker.ts` tried to insert
`dataKey` into a table that didn't have that column, and every file job
failed immediately with `column "data_key" of relation "ingestion_chunks"
does not exist`. Caught via a real bootstrap run against the DigitalOcean
database.

## What's explicitly out of scope

- No data migration for the old `data` column — nothing in `onix_ingester`
  or `server` has ever read from it (confirmed by search before dropping),
  so there was nothing to carry forward.
- `drizzle-kit generate`'s interactive rename-vs-create prompt couldn't be
  driven non-interactively in this environment, so this migration and its
  `drizzle/meta/0020_snapshot.json` were written by hand rather than
  generated. Verified consistent by running `drizzle-kit generate` again
  afterward and confirming it reports "No schema changes, nothing to
  migrate" — the hand-written snapshot matches the schema exactly.

## Testing done

- `tsc --noEmit` clean.
- Confirmed nothing in either `server` or `onix_ingester` reads
  `ingestion_chunks.data` before removing it.
- Ran `db:migrate` against the real DigitalOcean database (the one
  `DATABASE_URL` in `.env` currently points to) and confirmed via
  `information_schema.columns` that `data_key` (character varying) now
  exists and `data` is gone.
