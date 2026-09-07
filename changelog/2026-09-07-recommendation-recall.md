# Why the recommendation quiz sometimes came back with one book

**Date:** 2026-09-07

## What changed

`POST /recommendations` and `PATCH /recommendations/refresh?includeRecommendations=true`
now reliably return a full list. They were intermittently returning a handful of
books — sometimes a single one — for preferences that have thousands of good
matches in the catalogue.

Nothing about the request or response shape changes, and ranking is unchanged:
closer matches still come first, and books pulled in from the looser tier still
sort after every strict match.

## Why

The endpoint returns exactly what the pgvector search returns, so a short list
means the search itself came back short.

`books.embedding` is indexed with HNSW. That index is an approximate one: its
scan visits roughly `ef_search` nodes of the graph and then stops. Every
condition the recommendation search cares about — sellability, fiction versus
non-fiction, dislikes, the books the reader already owns or rejected — is applied
to whatever that scan handed back. It is a filter over the scan's output, not
something the scan knows about while it runs.

`ef_search` defaults to 40. So a query asking for a pool of hundreds was offering
its filter 40 candidates and keeping the few that survived. Measured against the
live catalogue (2,029,071 books, 1,119,411 with embeddings), the strict pass
returned **between 0 and 6 rows** of a requested 1000.

`books.service.ts` already widens `ef_search` for the feed queries, with a
comment saying that not doing so "would silently drop recall". The recommendation
search never got the same treatment, despite using a pool ten times larger.

## How it is wired

**The scan is widened.** Each search runs in a transaction that sets
`hnsw.iterative_scan`, which resumes the search when the filter has consumed a
batch instead of giving up. That, rather than a larger `ef_search`, is the actual
guarantee wanted here: `ef_search` only has to size the first batch, so it is set
to 100 rather than the 1000 ceiling. `SET LOCAL`, so neither setting escapes onto
the pooled connection.

`strict_order`, not `relaxed_order`, because `rank` in the response is the
position in cosine order and has to stay exact.

**The catalogue is read once, not twice.** The looser backfill tier used to be
its own query, filtered on `distance >= SIMILARITY_THRESHOLD`. That predicate
reads naturally and is the worst thing to ask of this index: the scan walks
outward from the nearest neighbour, so the filter rejects everything the scan
sees first, and an iterative scan grinds through that entire reject zone —
bounded only by `hnsw.max_scan_tuples` — before a single row qualifies. Both
tiers are now cut out of one pass in memory, split on the distance the query
already returns.

`FETCH_POOL` drops from 1000 to 300 as part of this. A large pool is free
headroom only under a brute-force mental model; under an iterative scan the
`LIMIT` is what the scan works towards, so it is paid for in latency. One pool of
300 now covers both tiers and divides itself — a preference set with few strict
matches simply spends more of it on backfill.

**A short list no longer sticks.** The cache key deliberately excludes the
reader's name, so two people with the same answers share an entry. That meant one
bad search was served to everyone with those preferences for the full 48 hours.
Lists below `MIN_HEALTHY_RESULTS` now get a one-hour lease and log a warning.

## Decisions worth naming

**pgvector's version is read from `pg_extension`, not from `SHOW`.** pgvector
registers its GUCs when its library first loads into a session, which happens
lazily on the first vector operation. On a freshly checked-out pooled connection
`SHOW hnsw.iterative_scan` therefore raises `unrecognized configuration
parameter` *even on 0.8.x* — verified on both 0.8.1 and 0.8.2. A capability probe
built on it reports "unsupported" on a server that supports it perfectly well,
and silently leaves recall capped.

**A failed probe is retried, not remembered.** The result is memoized for the
process, so what gets memoized matters. A version actually read back is
determinate either way; a query that never reached the server is not. Caching the
latter would let one blip — a failover, or a saturated pool during the first
request after a deploy — pin the process to the capped-recall path for its whole
life, silently reinstating this bug.

**`SET LOCAL` is safe before the library loads.** Postgres accepts any dotted GUC
name as a placeholder and pgvector adopts it when it loads, so the widening does
not depend on the probe having run first.

**Falls back rather than assuming.** On pgvector older than 0.8 there is no
iterative scan, so the search uses a single wide pass at the `ef_search` ceiling
of 1000 and logs that recall is capped. Production is on 0.8.1.

## Cost

Measured against the live catalogue with the real sellability and author
conditions applied:

| case | before | after |
| --- | --- | --- |
| typical preference vector | 6.5s / 11.2s | ~1.5s |
| sparse vector, backfill engages | 20.6s | 1.6s |

The gain is not only on the backfill path. In the typical cases above the strict
tier filled and the second query never ran, so that 6.5–11.2s was the *first*
pass alone: asking for 300 rows under the strict threshold makes the scan work
hard to find them, while the same pool under the looser bound fills sooner
because fewer rows are rejected on the way.

Absolute figures are from a developer machine over the public internet, so they
include network overhead a deployed instance would not pay; the ratios are the
meaningful part.

## Out of scope

- **A genuinely isolated preference vector still yields a short list.** If an
  embedding lands where the catalogue is empty, no amount of index recall
  invents neighbours — in testing, a deliberately off-cluster vector had two
  books within the outer threshold in the entire catalogue. That is a different
  problem with a different fix (loosening the outer bound, or falling back to a
  genre feed); the shortened cache lease above is what stops it being mistaken
  for this bug.
- **The `books.service.ts` feed queries.** Already widened, and their pools are
  small enough that the iterative scan is not needed there.
- **Tuning `hnsw.max_scan_tuples`.** Left at its default now that no query asks
  the index to skip its own best results.

## How it was verified

Reproduced before fixing: against the live catalogue, five preference vectors
under the real filters returned 0, 2, 3, 4 and 6 rows of a requested 1000 at the
default `ef_search`. After the change the same shape returns a full 100 every
time, with ids and titles unique and no strict match ranked below a backfilled
one.

`src/__tests__/vector-recall.test.ts` pins the invariants as source assertions,
in the same style as `recommendation-sellability.test.ts` and for the same
reason — this is a property of several separate query sites, and nothing in the
type system stops the next one being written without it. It pairs each ANN query
site with the guard in its own enclosing scope (counting occurrences would let a
guarded query vouch for an unguarded neighbour), rejects a reintroduced distance
floor, holds the search to a single pass, and pins both the `pg_extension` probe
and its retry-on-failure. A meta-test checks the site detector actually fails on
an unguarded query, and both new guards were confirmed red against a deliberately
reintroduced regression before being restored.

12 tests, all passing; `tsc --noEmit` clean.
