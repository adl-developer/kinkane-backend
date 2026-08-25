# Stop the index build running out of shared memory during deploys

**Date:** 2026-07-25

## What changed

Second follow-up to
[2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md)
and
[2026-07-25-hnsw-build-memory.md](2026-07-25-hnsw-build-memory.md).
Raising `maintenance_work_mem` to 256MB in that prior fix let Postgres
attempt a **parallel** HNSW index build — but parallel index builds
coordinate their workers through a dynamic shared-memory segment sized
roughly in proportion to `maintenance_work_mem`, and on this managed
instance that segment request exceeded available shared memory:

```
could not resize shared memory segment ... No space left on device
```

Added `SET max_parallel_maintenance_workers = 0` in
[setup.ts](../src/db/setup.ts) immediately before the `CREATE INDEX ...
USING hnsw` statement, so the build runs single-threaded and never requests
that segment, while keeping the larger `maintenance_work_mem` budget from
the prior fix.

Also added [db/ssl.ts](../src/db/ssl.ts) — a shared `resolveSslMode()`
helper — and pointed `db/index.ts`, `install-extensions.ts`, `reset.ts`, and
`setup.ts` at it instead of each independently checking
`databaseUrl.includes('sslmode=require')`. The helper resolves SSL by
hostname instead: managed Postgres providers (Render, DigitalOcean, etc.)
enforce SSL server-side regardless of what the connection string says, so a
URL missing `sslmode=require` doesn't mean the server actually accepts
plaintext — only `localhost`/`127.0.0.1` skip SSL now.

## Why

Both changes touch the same set of one-off DB scripts
(`db:setup`/`db:reset`/`db:install-extensions`) and `db/index.ts`, and the
SSL fix removes a duplicated (and previously inconsistent-in-intent) check
that existed separately in each file.

## What's explicitly out of scope

- Not a fix for the build being CPU-bound — HNSW construction still does
  real per-row graph work regardless of parallelism; single-threaded just
  avoids the crash, it doesn't make the build itself faster.
- No DigitalOcean-side configuration change — `max_parallel_maintenance_workers`
  is a plain session-level `SET`, not a superuser-restricted setting.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- Not independently re-run against a live `db:init` in this pass — worth
  confirming on the next deploy that the shared-memory error is gone and the
  build completes.
