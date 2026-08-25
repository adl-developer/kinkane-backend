# Stop `GET /books?q=` timing out on ordinary title searches by capping the result count

**Date:** 2026-07-27

## What changed

`GET /books?q=<multi-word title>` was timing out in production — `q=the alchemist`
and `q=the god of small things` both exceeded 25s and 90s respectively, repeatedly.
Meanwhile `GET /books/search` (typeahead) served the *same* queries in ~0.8s, and
plain browse and `/api/health` were fine, so the database itself was healthy.

Two independent causes, both fixed here:

**1. The exact `COUNT(*)` was the actual outage.** Even after the tiered matching
added in [2026-07-26-books-list-search-latency](2026-07-26-books-list-search-latency.md),
`list()` still computed an exact total against the broad (trigram + FTS) tier
whenever the cheap tiers matched fewer than 500 rows — which is *every* specific
multi-word title search. Since rows and total are awaited together, the count alone
kept the whole request slow no matter how fast the rows came back.

Searches now never run a count query of their own. They reuse the tier probes, and
every probe counts inside a `LIMIT`'d subquery (`countUpTo`) so Postgres stops as
soon as it has seen `SEARCH_COUNT_CAP` (1000) matches. Counting a search's full
match set is unbounded work: on the production catalogue (1.1M rows) `q=the` matches
~322k rows, and `EXPLAIN (ANALYZE, BUFFERS)` measured ~900MB of disk reads for a
single such count against a ~4GB-RAM instance.

**2. The broad tier was being used for rows far too eagerly.** Previously any query
whose prefix matches couldn't fill a whole page fell through to it. "The God of Small
Things" has 4 real editions against a 20-row page — so a perfectly ordinary title
search took the slowest path in the system. The broad tier is now reserved for
searches the cheaper tiers can't answer *at all* at the requested offset (in practice:
typos and pure fuzzy matches). Returning those 4 genuine matches is both far faster
and better ranked than padding the page out with fuzzy near-misses.

## API shape

`GET /books` gains two fields:

| field | meaning |
|---|---|
| `hasMore` | Whether more rows exist past this page. Computed by fetching `limit + 1` rows — no extra query. |
| `totalIsApproximate` | `true` when `total` is a floor rather than an exact count. |

`total` is **capped at 1000 for search queries** (`q` present). When
`totalIsApproximate` is `true`, `total` means "at least this many".

**Clients must paginate on `hasMore`, not by computing page counts from `total`.**
Filter-only browse (no `q`) is unaffected and still returns an exact total.

## Non-obvious decisions

- **The cap applies only to searches, not to filter-only browse.** Browse totals
  drive whole-catalogue pagination, where a capped number would be meaningless. That
  count was also never implicated in the timeouts, and is already cached for
  `COUNT_TTL` under a page-independent key — so it stays exact.
- **`totalIsApproximate` is derived (`total >= SEARCH_COUNT_CAP`), not stored.**
  Totals are served from Redis, so a stored flag would have to be cached alongside
  and kept in sync; deriving it keeps cache-hit and cache-miss paths consistent.
- **Count probes are capped at `SEARCH_COUNT_CAP + 1`, not `SEARCH_COUNT_CAP`.**
  Reaching exactly the cap has to be distinguishable from "exactly this many matches",
  which needs one row of headroom.
- **Cache keys bumped to `v2`.** The cached row payload changed shape (now
  `{ rows, hasMore }`) and cached counts are now capped, so pre-existing entries would
  deserialize into the wrong shape or serve uncapped totals.
- **The count decision stays independent of the requested offset**, as before, so
  every page of the same query agrees on one total rather than it drifting by
  whichever page happened to compute it first.

## What's explicitly out of scope

- **Typo/fuzzy queries are still slow.** A query matching nothing by prefix (e.g. a
  misspelling) still falls to the broad tier, which remains unbounded. This is the
  known limitation driving the search-engine evaluation — Postgres has no term
  dictionary, so its only typo mechanism is a trigram scan that must consider every
  candidate row. Unchanged by this pass.
- **Author-name search** — untouched.
- **Result deduplication by title+subtitle** (collapsing repeated editions into one
  row with an `otherEditions` field) — still outstanding, tracked separately.

## Testing done

- `tsc --noEmit` clean; `npm test` — existing 14 tests pass unchanged.
- Verified end-to-end against the **production** catalogue (1.1M rows):

  | query | before | after |
  |---|---|---|
  | `q=the god of small things` | timeout (>90s) | `total=4`, 4 correct rows |
  | `q=the alchemist` | timeout (>25s, twice) | `total=37`, `hasMore=true`, 20 rows |
  | `q=the` | 53s originally | `total=1000`, `totalIsApproximate=true`, 20 rows |
  | browse (no `q`) | — | exact `total=1110304` preserved |

- **Caveat on how that verification happened:** `.env` pointed at `localhost`, which
  at the time was a genuinely local 83k-row database, but partway through the session
  a tunnel to the production database was opened on the same port. The run above was
  therefore executed against production rather than locally, which was not the
  intent at the time. No writes were issued by the queries themselves; a dev server
  was briefly pointed at production during this (its queue workers were on local
  Redis, so no production email/push could be sent) and has been stopped. Worth
  re-confirming these numbers deliberately before relying on them.
