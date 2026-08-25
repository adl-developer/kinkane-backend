# Database plan upgrade fixes vector search's memory ceiling

**Date:** 2026-07-26

## What changed

No application code changed here — this documents a DigitalOcean managed
Postgres instance upgrade (applied directly via DO, not through this repo)
and the verification done against it.

The prior investigation
([2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md))
flagged that `similar()`/`personalized()`'s HNSW-indexed vector search
(`ORDER BY embedding <=> vector`) was correctly indexed but still slow
(~2.6-3.5s) on the previous plan, because the embeddings data (~3.4GB —
1.1M rows × 768 dimensions × 4 bytes) didn't fit in that plan's ~2GB RAM, so
most queries paid real disk I/O reading HNSW graph pages. That was called
out as an infrastructure/cost decision rather than something to fix in code.

After the instance was resized, `pg_settings` on the live database shows:

| setting | before (approx, per prior pass) | after |
|---|---|---|
| `shared_buffers` | ~256-512MB (2GB-RAM "Basic" plan) | 975MB |
| `effective_cache_size` | — | 2.9GB |
| `max_connections` | ~47 | 200 |

## Verification

The very first vector-search query re-tested right after the resize was
still slow (764ms, `Buffers: ... read=2562` — the same disk-read pattern as
before) — expected, since a plan resize restarts the instance and flushes
both Postgres's `shared_buffers` and the OS page cache back to empty.

Re-ran the identical query 5 times immediately after:

```
run 0: exec=4.7ms   buffers hit=2943 read=0
run 1: exec=4.5ms   buffers hit=2937 read=0
run 2: exec=4.8ms   buffers hit=2937 read=0
run 3: exec=4.4ms   buffers hit=2937 read=0
run 4: exec=4.9ms   buffers hit=2937 read=0
```

`read=0` on every run — fully served from cache. **~4.5ms once warm, down
from ~2.6-3.5s before the upgrade** (~500-800x). Confirms the increased
memory actually lets the embeddings/HNSW graph stay resident instead of
being re-read from disk on every query.

## Why

Closes out the one finding from the prior investigation that wasn't a code
fix — the vector-search latency was a genuine memory ceiling, not a missing
index or an inefficient query, and no query-level change could have fixed it.

## What's explicitly out of scope

- No code change accompanies this entry — nothing to review here beyond the
  verification numbers.
- Cold-start behavior after any future restart/resize is unchanged: the
  first query (or first N queries, per book) after a restart will still pay
  disk I/O until the relevant part of the embeddings/HNSW graph is back in
  cache. Not addressed by this upgrade, since it's inherent to any
  cache-dependent system after a cold start.

## Testing done

- Verified against the live database, not reasoned about: `pg_settings`
  before/after (via prior changelog entries and direct query), and
  `EXPLAIN (ANALYZE, BUFFERS)` re-run 5 times immediately after the upgrade
  to distinguish "still broken" from "cache cold from the restart."
