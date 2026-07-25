# Speed up the vector index build during deploys

**Date:** 2026-07-25

## What changed

Follow-up to
[2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md).
After deploying that change, `db:init` sat for a long time on the new HNSW
index build, and Postgres logged:

```
NOTICE: hnsw graph no longer fits into maintenance_work_mem after 40503 tuples
DETAIL: Building will take significantly more time.
```

`maintenance_work_mem` defaults to 64MB — once the in-progress HNSW graph
outgrew that budget, Postgres fell back to a much slower, more
disk-dependent build strategy for every row after the first ~40,503. Added
`SET maintenance_work_mem = '256MB'` in
[setup.ts](../src/db/setup.ts) immediately before the `CREATE INDEX ...
USING hnsw` statement, so the build gets more headroom before hitting that
fallback.

## Why 256MB

The database is a DigitalOcean "Basic" managed Postgres instance — 1 shared
vCPU, 2GB total RAM. `setup.ts` runs as part of the deploy's `db:init` step,
which means the live app is likely still serving traffic against this same
database while the build runs, so this isn't a box with 2GB free to spend
entirely on one operation. 256MB is a 4x increase over the default with
comfortable headroom left for `shared_buffers` and concurrent connections
(up to 47 per the plan's connection limit). Scoped to just this one
statement, on a connection `setup.ts` closes right after — not a persistent
or database-wide change, and no DigitalOcean-side configuration needed
(`maintenance_work_mem` isn't a superuser-restricted setting, so a plain
session-level `SET` works over a normal connection regardless of what
DigitalOcean's control panel happens to expose).

## What's explicitly out of scope

- Not a fix for the build being fundamentally CPU-bound — HNSW construction
  does real per-row graph work (nearest-neighbor search + insertion for
  every embedded book) regardless of available memory, and this plan's
  single shared vCPU is a separate constraint this change doesn't address.
  Expect the build to still take real time, just without the disk-thrashing
  fallback making it worse.
- No change to the plan size itself — if the catalogue grows enough that
  256MB stops being sufficient, the next lever is either raising this value
  further (bounded by the instance's actual RAM) or upgrading the DB plan.

## Testing done

- `tsc --noEmit` clean.
- Not re-run against the live database in this pass — the value was chosen
  from the plan's published specs (2GB RAM / 1 shared vCPU), not measured
  headroom; worth watching the next `db:init` run to confirm the NOTICE
  moves later (or disappears) and doesn't regress into new memory pressure
  elsewhere on the instance.
