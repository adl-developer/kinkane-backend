# New users default to a public shelf

**Date:** 2026-07-21

## What changed

The `shelf_visibility` column on `users` now defaults to `'public'` instead
of `'private'`. This only affects the default applied when a row is
inserted without an explicit value — existing users keep whatever value
they already have, nothing is backfilled.

Migration: [`drizzle/0020_fuzzy_nightmare.sql`](../drizzle/0020_fuzzy_nightmare.sql)

```sql
ALTER TABLE "users" ALTER COLUMN "shelf_visibility" SET DEFAULT 'public';
```

## Why

New accounts were landing with a private shelf by default, which hides
their reading activity from other users until they explicitly opt in to
sharing it. Defaulting to public matches the intended social experience out
of the box; users can still switch to `'friends'` or `'private'` via the
existing shelf visibility setting.

## Scope

Only the column default changed. No API surface, validation, or existing
row data was touched.

## Verification

Confirmed via `drizzle-kit generate` that the only diff produced is the
`ALTER COLUMN ... SET DEFAULT` statement above — no other schema drift.
