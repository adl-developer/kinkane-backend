# Author bios on book pages, and BDS review quotes where Nielsen has none

**Date:** 2026-09-22

## What changed

Book detail responses gain an `authorBio` field, and `review` gains a `source`:

```json
{
  "id": 57402,
  "review": {
    "reviewHtml": "<p>'Compelling' <i>The Observer</i></p>",
    "source": "bds",
    "sourceField": "review"
  },
  "authorBio": {
    "bioHtml": "<p><strong>Jane Author</strong> lives in Leeds ...</p>",
    "sourceField": "author_bio"
  }
}
```

Both come from BDS (Bibliographic Data Services), whose API returns author
biographies and press review quotes keyed by ISBN. Gardners' ONIX carries
neither. Both fields are `null` when we have nothing; expect that for most of
the long tail.

The feature is behind `BDS_ENRICHMENT_ENABLED` (default `false`), which also
needs `BDS_USERNAME` and `BDS_PASSWORD`. We have no credentials yet, so
**none of this has run against the real BDS service**. See "Not verified".

## Data

- **`book_author_bios`** (new): one row per ISBN asked about. `bio_html` is
  NULL for "asked, BDS had nothing". It is keyed by ISBN, not by contributor:
  BDS give one bio block per book with no author identifier, and
  `book_contributors` rows are rebuilt on every ingest, so a foreign key to
  them would break. `source_updated` holds BDS's last-changed date, so the
  daily change pass can skip records we already hold at that version.
- **`book_reviews`** gains `source` (`nielsen` | `bds`). The unique key moves
  from `isbn13` to `(isbn13, source)`, so each source keeps its own "asked,
  nothing" rows and a miss at one can't hide a hit at the other. Existing
  rows default to `nielsen`. When both sources have a quote, Nielsen's is
  shown. They aren't merged, because both carry publisher-supplied quotes and
  showing both would mostly repeat them.

Migration: `drizzle/0068_bds_author_bios_and_review_sources.sql`.

## How it's filled

One BDS call answers up to 100 ISBNs and returns bio and review together.

- **Nightly (`BDS_ENRICHMENT_CRON`, 02:30):** first picks up yesterday's
  changes at BDS, for books we've already looked up, using the
  `index_updated` field. BDS's documented `SINCE`/`DTSPAN` operators filter
  on publication date, not on when a record changed. It then sweeps up to
  `BDS_NIGHTLY_ISBN_LIMIT` active books not yet asked about, newest first. A
  Redis lock makes a cluster run this once, not once per worker.
- **On demand:** opening a book with no bio triggers a background lookup if
  BDS have never been asked about it, using the same pattern as Nielsen.
- **Backfill:** `npx tsx scripts/bds-backfill.ts` runs the sweep over the
  whole catalogue: about 11,000 calls for about 1.1M active books. It can be
  stopped and re-run safely.

BDS return errors as HTTP 200 with a JSON body, so the client checks the
body. When a token is rejected, it logs in once more and retries.

## Phase 0: measuring before switching on

`npx tsx scripts/bds-probe.ts` runs `isbn-sample-500.csv` through the API. It
writes raw responses, a per-ISBN CSV and a summary to `probe-output/`, which
is git-ignored because it holds licensed text. It checks, in order:

1. Login works, and our guessed field names exist.
2. A batched 100-ISBN query returns the same records as asking one at a time.
3. Bio, review, prizes and related-editions coverage.
4. How many BDS reviews are for books Nielsen has none for.

## Not verified (no credentials yet)

The client is written from BDS's API document and their sample responses. Four
guesses need confirming by the probe on its first real run:

- **Batch query syntax:** `SF1=identifier&ST1=a OR b OR ...`.
- **Field names we ask for:** `author_bio`, `biographical_note`, `review`,
  `prizes`, `related_editions`, `index_updated`.
- **How `author_bio` and `biographical_note` differ.** We prefer `author_bio`.
- **How `index_updated` range queries and deep paging behave.**

## Out of scope

- **Embedding bios/reviews for recommendations.** This needs BDS's explicit
  licence permission, and a re-embedding job in `onix_ingester`.
- **Author pages that share one bio across books.** This needs name matching,
  with a known risk of attaching the wrong person's bio.
- **Storing prizes and related editions.** The probe measures them; storing
  them is a follow-up. Related editions could fix the Jellybooks excerpt
  mismatch.
- **Parsing review sources into their own fields.**

## Tests

- `bds-client.test.ts` (15): both XML shapes, CDATA vs escaped text, empty
  placeholders, login and token caching, retry on a rejected token, batching.
- `bds-enrichment.integration.test.ts` (10, real Postgres): storing hits and
  misses, Nielsen and BDS rows side by side with Nielsen preferred, sweep
  order and recheck window, delta updating only changed rows we know,
  page-cap warning, on-demand de-duplication, and the cluster lock.
- The probe was run end to end against a local fake BDS server.
- Book detail was checked on a local server with seeded rows.
