# Recommendation lists shortened from 100 books to 50

**Date:** 2026-09-22

## What changed

Readers now get 50 recommendations per list instead of 100, and the vector
search that finds them does proportionally less work.

- `RECO_TARGET_RESULTS` defaults to **50** (was 100). This is how many results
  the client receives, and it also sizes the candidate pool the search fetches.
- `HNSW_EF_SEARCH` is **50** (was 100). This sizes the first batch of the
  iterative index scan; with iterative scan the search resumes rather than
  giving up when filters eat a batch, so it only needs to cover that first
  batch.
- `BASELINE_TARGET_RESULTS` is **50** (was 100), moved together with the
  default.

## Why the baseline had to move with the default

`BASELINE_*` exists to recognise an environment that has changed nothing. When
all the recommendation settings match it, the cache key carries no fingerprint
and stays byte-identical to the previous release, so a deploy keeps its warm
cache instead of recomputing 48 hours of entries.

That only works while the baseline equals the configured default. Had the
default moved to 50 and the baseline stayed at 100, every untouched environment
would have stopped matching, gained a fingerprint, and flushed its cache on
every deploy. The test that pins these constants now asserts they track the
defaults, rather than asserting the historical pre-weighting values.

## One consequence after deploy

Because the cache key does not change, recommendation sets already cached at
100 books keep being served until they expire — within 48 hours
(`CACHE_TTL_HOURS`). New and refreshed entries are computed at 50. This is the
intended trade: a brief period of longer lists, instead of a cold cache.

## Context

The config notes that the candidate pool "is paid for in latency, not just
memory": measured against the live catalogue, 300 rows return in ~800ms and
1,000 in ~5–18s, because the iterative index scan works towards the LIMIT.

## How it was verified

The unit suite passes in full (951 tests), including the updated
baseline-pinning test in
[preference-weights.test.ts](../src/__tests__/preference-weights.test.ts).
