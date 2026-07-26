# Stop /books from waiting on a full-table count every load

**Date:** 2026-07-25

## What changed

Follow-up to
[2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md),
which cached `list()`'s full result (rows + total) together under one 5-minute
key. That fixed the common case, but every cache expiry still paid for an
exact `COUNT(*) FROM books` — on this ~1.1M-row table that took 5-8 seconds
per `GET /api/v1/books` cache miss, confirmed with `EXPLAIN (ANALYZE,
BUFFERS)` against the live database:

```
Parallel Index Only Scan using idx_books_is_removed on books
  Heap Fetches: 457245
  Buffers: shared hit=602 read=82979
```

An index-only scan is supposed to avoid the heap entirely; 457k heap fetches
out of ~1.1M rows meant the visibility map was stale — the table takes
constant upserts from the Gardners ONIX ingestion pipeline and autovacuum
(`last_autovacuum`/`last_autoanalyze` were both `null`) wasn't keeping up.

Two changes:

1. **Ran `VACUUM ANALYZE books`** against the live database — brought heap
   fetches to 0 and dropped the same `COUNT(*)` to ~350ms.
2. **Lowered `autovacuum_vacuum_scale_factor`/`autovacuum_analyze_scale_factor`
   to 0.02 (from the 0.2 default)** via `ALTER TABLE books SET (...)` —
   metadata-only, no lock, no table scan. At the default, autovacuum won't
   consider vacuuming this table until ~220k dead rows accumulate; at 0.02
   that's ~22k, so the visibility map should stay fresh continuously instead
   of drifting stale again over weeks of ingestion traffic.
3. **Decoupled the count from the row cache in
   [books.service.ts](../src/services/books.service.ts)'s `list()`.** Rows and
   count are now cached under separate keys: rows keep the existing 5-minute
   TTL, but the count is keyed only on the filter fields (`q`, `genre`,
   `availability`, `productForm`, `publishingStatus`, `publisher` — not
   `limit`/`offset`/`sort`, which don't affect it) and cached for 30 minutes.
   `COUNT(*)` is the expensive half of this query even with a healthy
   visibility map; the total also barely changes minute to minute, so there's
   no reason to recompute it on every 5-minute row-cache expiry, or once per
   distinct page/sort of the same filter as before.

## Why

The vacuum/autovacuum fix addresses the immediate cause (stale visibility
map). The caching change addresses the structural one: an exact `COUNT(*)`
over a filtered slice of a growing table is inherently more expensive than
fetching one page of rows, so it shouldn't be tied to the same short TTL or
recomputed per distinct pagination/sort combination.

## Non-obvious decisions

- **Kept the count exact rather than switching to an estimate.** Consistent
  with the prior performance pass's decision to leave pagination totals
  correct; this pass only changes how often the exact count is computed, not
  its accuracy.
- **30 minutes, not longer.** Long enough to absorb nearly all traffic
  between autovacuum-driven visibility-map refreshes, short enough that the
  displayed total doesn't drift far behind reality as ingestion adds new
  books.

## What's explicitly out of scope

- No change to pagination style — still offset/limit. Offset cost grows with
  page depth, but wasn't the measured bottleneck here (offset 0 was already
  ~10-140ms); worth revisiting only if deep pagination becomes a complaint.
- No stale-while-revalidate or cache pre-warming — discussed as a further
  option to eliminate the remaining cold-cache latency entirely, not
  implemented in this pass.
- Root-caused, but did not change, a separate finding while investigating
  this: new connections from a local dev machine to this DigitalOcean
  instance were intermittently slow/timing out even before any query ran,
  and one long-running `VACUUM ANALYZE` was cut off mid-operation by a read
  timeout on the first attempt (succeeded on retry). Worth keeping an eye on
  whether this affects the deployed app too, depending on the deployed
  region's network path to this database.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- Verified against the live database and running dev server, not just
  locally reasoned about:
  - `EXPLAIN (ANALYZE, BUFFERS)` on the count query before and after
    `VACUUM ANALYZE` (5.5s / 457k heap fetches → ~350ms / 0 heap fetches).
  - `ALTER TABLE ... SET (...)` applied and confirmed via
    `pg_class.reloptions`.
  - Hit the running `GET /api/v1/books` with Redis fully flushed of
    `books:*` keys: full cold miss dropped from ~8s to ~0.5-2s; confirmed the
    two cache keys (`books:list:*`, `books:count:*`) are created with their
    respective TTLs; confirmed a rows-miss/count-hit request (simulating the
    row cache's 5-minute expiry with the count still warm) returns the
    correct `total` in ~0.5s instead of paying for the count again.
