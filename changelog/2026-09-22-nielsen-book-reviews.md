# Press review quotes on book pages, from NielsenIQ BookData

**Date:** 2026-09-22

## What changed

Book detail responses now carry a `review` field: press review quotes for the
title, sourced from the NielsenIQ BookData Online web service and keyed by
ISBN.

```json
{
  "id": 12345,
  "title": "Orbital",
  "review": {
    "reviewHtml": "<b>Our unanimity about <i>Orbital</i>...</b> ... * Observer * ...",
    "sourceField": "NBDFREV"
  }
}
```

`review` is `null` when we have nothing — which is the common case, see
Coverage below. `reviewHtml` is HTML and needs the same client-side treatment
as `longDescription` already gets; the outlet attributions ("* Observer *",
"-- Edmund de Waal, Chair of the 2024 Booker Prize judges") are embedded in
the prose rather than supplied as separate fields.

The whole feature is behind `NIELSEN_REVIEWS_ENABLED`, which defaults to
`false` and additionally requires both credentials to be set. The account is
metered per record, so a deploy should not start spending the allowance on its
own.

## Where the reviews come from

Two paths, splitting one daily allowance:

- **A nightly batch** (`NIELSEN_REVIEWS_CRON`, default 01:00) spends up to
  `NIELSEN_DAILY_BATCH_BUDGET` records (default 900).
- **On-demand**, when a book page is opened for a title nobody has asked about
  yet, spending up to `NIELSEN_DAILY_ONDEMAND_BUDGET` (default 100).

The on-demand lookup is fire-and-forget: a book page never waits on Nielsen.
The first visitor to an unchecked book sees the page without a review, the
lookup runs behind them, and on success it deletes the cached book detail so
the next request serves the review. It is fired *after* the cache is written —
firing before would let the delete land first and cache the review-less copy
for the full hour.

## Coverage — read this before building UI on it

Measured live against the trial account on 2026-09-21: **61 of 200 (30%)** of a
real catalogue ISBN sample had review text. Samples weighted towards US
editions or the self-published/foreign-language long tail came in nearer 12%.
Hits concentrate in traditionally published, notable titles; 979-8 KDP
imprints, foreign-language editions and academic monographs have essentially
none.

So a book page with no review is the normal case, not a failure, and the UI
should treat the review block as optional decoration rather than a slot that
looks broken when empty.

## Data model

New `book_reviews` table ([book-reviews.ts](../src/db/schema/book-reviews.ts)):

| column         | notes                                                        |
|----------------|--------------------------------------------------------------|
| `isbn13`       | unique — the join key, since Nielsen is ISBN-native           |
| `review_html`  | nullable; NULL means "asked, they had nothing"                |
| `source_field` | which territory variant supplied it (NBDFREV/AUSFREV/NZFREV)  |
| `checked_at`   | when we last asked, indexed for the re-check sweep            |

Recording misses is load-bearing rather than tidy bookkeeping: 70% of the
catalogue has no review, so without a miss row every visitor to a reviewless
book would spend another record of the day's allowance on the same question.
Misses are re-asked after `NIELSEN_MISS_RECHECK_DAYS` (default 90), because
reviews are often filed weeks after publication — an empty answer in week one
is not an empty answer forever.

New `nielsen_api_usage` table, one row per day, tracking `batch_used` and
`on_demand_used` separately so the nightly job cannot eat the visitors'
allowance.

## Non-obvious decisions

**The budget lives in the database, not in memory.** The quota is per-account,
not per-process: web dynos, the cron and any worker all draw on the same
1,000/day, and in cluster mode the cron runs in every worker at once. Every
lookup claims a record with a single guarded `INSERT ... ON CONFLICT DO UPDATE
... WHERE ... RETURNING`, so concurrent callers compete for one budget instead
of multiplying it. The claim happens *before* the request and is never
refunded on failure — we cannot tell from an error whether Nielsen served the
record before we failed to read it, and overcounting costs a lookup while
undercounting risks breaching the account limit.

**Our counter is an estimate; Nielsen's answer is authoritative.** They publish
no quota endpoint and return no usage figures — the response envelope is just
`clientId`, `format`, `resultCode`, `hits`, `from`, `to`. So `resultCode` 50
(LIMITS_EXCEEDED) sets `limit_hit_at`, which stops both halves of the budget
for the rest of the day regardless of what our own counters say.

**How long a full sweep takes depends on whether Gardners ingestion is on.**
The job works newest-first through titles with publishing status `04`. With
full-catalogue ingestion off, as it is today, `books` holds 83,688 rows of which
~71,600 are eligible — at 900/day that is a complete sweep in about 80 days,
after which the job only re-checks misses. If `GARDNERS_INGESTION_ENABLED` is
turned on, the catalogue becomes ~2M and a sweep would take about six years, at
which point the ordering stops being a detail and becomes the whole question:
most titles would only ever get a review through the on-demand path.

Newest-first has a visible cost on day one: the latest publication dates in the
catalogue are dominated by academic publishers pre-loading forward records
(Springer Nature Switzerland and Singapore, the AMS, World Scientific), which
have essentially no review coverage. The first minutes of the first run were a
solid block of misses for that reason, not a fault. If the books readers
actually open should be covered first, change the candidate query's ordering.

**A regex, not an XML parser.** The server has no XML dependency (onix_ingester
uses `sax`, but that is a streaming parser for whole ONIX files). This response
is small and we want three scalar fields from it, and Nielsen entity-escapes
field values — the review arrives as `&lt;p&gt;…`, never raw markup — so a
value can never contain the closing tag the match stops at. Anything needing to
understand the record as a whole should bring a real parser.

**Always https.** The developer guide prints the base URL as `http://`. The
service 301s to https, and both the client ID and password travel in the query
string, so the default starts at https rather than letting credentials make an
unencrypted first hop.

## Known documentation traps

Four errors in the vendor's REST guide cost time and are worth recording:

- The endpoint is `/BDOLRest/RESTwebServices/BDOLrequest` — easy to misread as
  `BDORest`/`BDOrequest`, which 404s.
- The documented `http://` base URL 301s to https.
- The response envelope returns `<hits>`, not the documented `<totalHits>`.
- Search field 29 (country of publication) returns zero hits for `GB`, and
  `territory=UK` only selects which descriptive-field variant comes back — it
  does **not** filter results to UK editions.

## Out of scope

**Parsing attribution into structured quote/source pairs.** The text uses at
least three conventions — `-- Name`, `* Publication *`, and `"-- "Source"` —
sometimes within one field. The blob is stored as supplied; splitting it into
separately attributed pull-quotes can be done later against stored data,
without spending any more of the allowance.

## How it was verified

- Unit tests ([nielsen-reviews.test.ts](../src/__tests__/nielsen-reviews.test.ts))
  cover parsing, both "no review" shapes (absent element and the literal
  `No reviews available` placeholder), territory fallback, the two error
  result codes, `resultView=2`, https, and that a password containing `&`
  survives into the query string intact.
- The client was run against the live service: *Orbital* returned 1,758
  characters of decoded HTML, *A Town Called Solace* 1,304, and *Awful Auntie*
  correctly returned null from the placeholder.
- An integration suite
  ([nielsen-budget.integration.test.ts](../src/__tests__/nielsen-budget.integration.test.ts),
  `npm run test:integration`) covers the budget claim against a real Postgres,
  including 40 callers racing for the last 5 records. It runs against
  `TEST_DATABASE_URL` only, skips itself when that is unset, and refuses to run
  when it names the same database as `.env`. Its skip path and that guard were
  verified; **its assertions have not yet run**, because no writable database
  was reachable while it was written. Run it once against a scratch database.
- First production run, 2026-09-22 06:06 UTC: 69 of the first 292 books checked
  had review text (23.6%), in line with the measured ~30%, with the batch
  claiming records at about 2 per second and no limit errors.
