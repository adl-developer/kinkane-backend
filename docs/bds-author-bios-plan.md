# Plan: author biographies, and review quotes where Nielsen has none

**Written 2026-09-25**, after the BDS licence was attached and the API measured
against the real catalogue. **Revised the same day** after a backfill trial of
~200 live calls, which changed the delivery design (see "What the API can and
cannot do" and Part 3). Companion to
`changelog/2026-09-22-bds-author-bios-and-reviews.md`, which describes what is
already built and shipped (switched off).

## Where we stand

Measured with `scripts/bds-probe.ts` against `isbn-sample-500.csv`:

| | Result |
|---|---|
| BDS holds the book | 494/500 (98.8%) |
| Author bio (`author_bio`) | 326/500 (65.2%), median 411 chars |
| Review quote (`review`) | 149/500 (29.8%), median 896 chars |
| Related editions | 287/500 (57.4%) |
| Prizes | 3/500 |
| `biographical_note` | does not exist as a field; `author_bio` is the only bio |

A live sweep of 200 books took 5.5 seconds; a sustained 2,000-book sweep ran at
38 books/sec, which is 8 hours for 1.1M books serially, or about 2.5 hours with
a few requests in flight at once.

Local catalogue shape, which decides how far bios can be pushed:

| | Count |
|---|---|
| Active books with exactly one main author (A01) | 48,597 (~71%) |
| Books with 2 authors | 6,453 |
| Books with 3+ authors | ~2,800 |
| Books with no A01 at all (edited volumes) | 11,577 |
| Distinct A01 authors | 58,640 |

And how well a bio can be tied to a person, over the 156 bios fetched live:

| | Count |
|---|---|
| Bio on a single-author book | 93 |
| …whose text names that author's surname | 87/93 (94%) |
| Bio on a multi-author book | 30 |
| …whose text names **every** author | 23/30 |
| Bio on a book with no A01 | 33 |

**The core constraint: BDS supply one bio blob per book, which may cover
several contributors, and carry no author identifier.** Per-author bios must
therefore be derived, and that derivation is the only real risk in this plan.

## What the API can and cannot do

Measured over ~200 live calls on 2026-09-25. **No call failed, at any point.**

| | Measured |
|---|---|
| Records per call (`PL`) | **hard cap of 100** — asking for 200 or 500 still returns 100 |
| Paging window | **`offset + page size <= 5,000`**. Offset 4,991 works; 4,992 returns an **empty result with no error** |
| Page overlap | pages overlap by one record (offset 10 starts at result 10), so paged reads must deduplicate |
| Records BDS change per day | **~136,000** (692,367 over 7 days) |
| Throughput, serial with a 500ms delay | 38 books/sec → 8 hours for 1.1M |
| Throughput, 4–6 requests in parallel | 3.1x faster, zero failures, no latency drift → ~2.5 hours |
| Rate limiting | none documented, no `X-RateLimit-*`/`Retry-After` headers, none observed in a 30-call burst at concurrency 6 |
| Token | JWT valid one year, `scope: {"acs_user_licence_code":"book"}` |
| Response size | ~326KB per 100 records, so a full pass moves ~3.6GB |
| ISBNs BDS does not hold | ~1.2% |

**The consequence that reshaped this plan:** BDS change ~136,000 records a day,
and only the first 5,000 of any result set can be read. A "what changed
yesterday" query can therefore see about 4% of the changes, and going past the
window looks identical to reaching the end of the results. **The daily-delta
approach cannot work over this API**, whatever page size or date range is used.

Unlike Nielsen, there is no metered daily allowance — no budget table is
needed. That is an observation, not a guarantee: nothing in writing says so,
and a full refresh is two orders of magnitude more traffic than this trial.

## What the data looks like

Request (`GET xmla-api.php`, bearer token):

```
SF1=identifier&ST1=9780241635537&PL=1&VIEW=xml
&FIELDS=barcode,identifier,author_bio,review,prizes,related_editions,index_updated
```

Response, trimmed:

```xml
<resultscollection>
  <resultsetinformation>
    <documentcount>1</documentcount>
  </resultsetinformation>
  <resultfields>
    <fv_author_bio><![CDATA[Selina Brown is an Author, Marketing Consultant and Event
      Producer. At 16 she became the Youth MP for Nottingham ... During the pandemic she
      wrote the picture book series <i>Nena</i> ...]]></fv_author_bio>
    <fv_barcode>9780241635537</fv_barcode>
    <fv_identifier>0241635535</fv_identifier>
    <fv_identifier>9780241635537</fv_identifier>
    <fv_identifier>BDZ0055680738</fv_identifier>
    <fv_index_updated>20260914</fv_index_updated>
    <fv_prizes><![CDATA[Klaus Flugge Award. British Book Industry Awards.]]></fv_prizes>
    <fv_related_editions>9780241635551|9780241635803|9780241635551|9780241635803</fv_related_editions>
    <fv_review><![CDATA["With the rising demand for inclusive stories that celebrate
      different cultures, My Rice is Best is<b> a timely addition to bookshelves...</b>
      <br /><i>The Voice - The Voice</i><br /><br />"The interactive dialogue, humour and
      deeper messaging... <b>a delight to share."</b><br /><i>The Blk Brit - The Blk Brit</i>
      ...]]></fv_review>
  </resultfields>
</resultscollection>
```

Things this dictates, all handled in `lib/bds.ts`:

- Text is **HTML inside CDATA**, with mixed markup (`<p>`, `<b>`, `<i>`,
  `<br />`) and leftover entities, including Windows-1252 ones such as
  `&#148;`. It must be rendered and sanitised exactly like `longDescription`.
- **Review attributions live inside the prose**, in several conventions
  (`<i>The Voice - The Voice</i>`, `--<b>Source, date</b>`). Outlet names are
  often doubled. There is no structured source field.
- A record holds **several reviews concatenated** into one value.
- `related_editions` repeats values; the parser deduplicates.
- BDS return fields we did not ask for (`fv_ref_no`, `titleurl`), and the ISBN
  must be recovered from `fv_barcode` or the `fv_identifier` list.

---

# Part 1 — Author biographies

## 1.1 Book detail returns the bio, at book level and per contributor

The book detail endpoint already returns the book-level bio, live today:

```json
{
  "id": 82916,
  "title": "Health in the Era of Digitalization",
  "contributors": [
    { "role": "B01", "personName": "Arnaud Bernaert", "sequenceNumber": 1 },
    { "role": "B01", "personName": "Kanupriya Agarwal", "sequenceNumber": 2 },
    { "role": "B01", "personName": "Russell Hanson", "sequenceNumber": 3 }
  ],
  "authorBio": {
    "bioHtml": "<p>Kanupriya Agarwal, MD is a physician, researcher and entrepreneur...</p><p>As Chief Innovation Officer at Sama Therapeutics, Russell Hanson leads iMAGiNE...</p>",
    "sourceField": "author_bio"
  },
  "review": null
}
```

That example is the awkward case in miniature: three editors, one blob covering
at least two of them. It is also why `authorBio` stays at book level and is not
silently attributed to the first contributor.

**The change:** add `bio` to each entry of `contributors`, populated only where
attribution is unambiguous:

```json
"contributors": [
  {
    "role": "A01",
    "personName": "Selina Brown",
    "sequenceNumber": 1,
    "bio": { "bioHtml": "<p>Selina Brown is an Author...</p>", "confidence": "high" }
  }
]
```

Rules:

- **Exactly one A01 on the book** → attach the book's bio to that contributor
  (~71% of books).
- **Only if the bio text names that contributor's surname** (94% of the time).
  The 6% that fail are exactly the cases where the blob is about someone else.
- **Two or more authors, or no A01** → no per-contributor bio. `authorBio`
  still carries the blob, so nothing is lost on the page.

`authorBio` keeps its current meaning and shape, so existing clients are
unaffected. This phase adds no new table and no inference beyond the surname
check.

## 1.2 An author-level bio store

For an author page, a bio has to belong to the person rather than the book:

```
author_bios(
  normalised_name  text primary key,   -- lib/contributor-name.ts normalisation
  display_name     text,
  bio_html         text,
  source_isbn13    varchar(13),        -- the book it came from
  source_updated   varchar(8),         -- BDS index_updated of that record
  book_count       int,
  confidence       text,               -- 'high' | 'ambiguous'
  checked_at       timestamptz
)
```

Normalisation matters: 22% of contributor rows have doubled internal spaces, so
a raw string key would split one author into two.

A job walks the confirmed book→author attachments from 1.1 and picks, per
author, the bio from their **most recently published** book. Bios go stale, and
the newest is usually the fullest.

## 1.3 The name-collision guard

Two different people share a name. Keying on name alone merges them and puts
one person's biography on another's books — the same failure that ruled out the
Wikipedia approach (measured wrong matches included a farmer, a biathlete and a
racing driver).

Rule: when an author's books yield **more than one materially different bio**
(low word overlap between candidates), store them but mark
`confidence = 'ambiguous'` and **serve no author-level bio**. Book pages are
unaffected — their bio came with the book, so it is right regardless.

## 1.4 Serving it

- `GET /authors/search` gains `hasBio`, so the UI can mark authors with one.
- New `GET /authors/:name` → display name, bio, book count, their books. This
  is the author page the API does not have yet.
- Book detail: unchanged except for the new `contributors[].bio`.

## 1.5 Splitting multi-author blobs — deferred

BDS often format these with bold name headers
(`<b>Jane Foster (Author, Illustrator)</b><br>…`), so sections could be split
and matched to contributors. Held back deliberately: it is heuristic, and 23/30
multi-author bios already name every author, so the whole blob reads sensibly at
book level.

---

# Part 2 — Review quotes where Nielsen has none

Both sources carry reviews on ~30% of books, but Nielsen is metered at 900
records a day — about 3.4 years for the catalogue — while BDS answer 100 ISBNs
per call.

## 2.1 Prioritise the gap
The nightly BDS sweep currently works newest-first through books it has not
asked about. Add a first pass over books where **Nielsen has already answered
"no review"**, plus books Nielsen will not reach for years. That is exactly
where a BDS review adds something new.

## 2.2 Serving is already built
`book_reviews` is keyed by `(isbn13, source)` and Nielsen wins when both have a
quote, so BDS reviews only ever appear where Nielsen has nothing. Covered by
the integration suite.

## 2.3 Let Nielsen's budget go further
Once BDS has swept the catalogue, a book with a BDS review no longer needs a
Nielsen lookup. Point Nielsen's 900 a day at books where **neither** source has
anything.

## 2.4 Measure the gain
After the backfill: books with a review before and after, how many came from
BDS alone, and the overlap between the two sources — enough to judge whether
the Nielsen subscription still earns its place.

---

# Part 3 — Getting the data in, and keeping it fresh

Revised after the trial. What is built today assumes a daily delta the API
cannot serve, so this part replaces it.

## 3.1 The backfill (one-off, ~1.1M books)

`scripts/bds-backfill.ts` works today, with two changes before it runs for real:

- **Iterate by keyset, not by `ORDER BY publication_date`.** The current
  candidate query is a sequential scan plus a sort over `books` — 251ms at 83k
  rows locally, so several seconds per page at 1.1M, repeated for every page.
  Walking `books.id` in ranges removes both.
- **Make concurrency configurable** (`BDS_CONCURRENCY`, default 1). At 4–6 the
  trial ran 3.1x faster with no failures, cutting 8 hours to ~2.5. Default it
  to 1 until BDS confirm parallel requests are acceptable.

Everything else already holds: 100 ISBNs per call, every answer committed as it
arrives, misses recorded, safe to stop and re-run.

## 3.2 Keeping it fresh: a rotating re-sweep, not a delta

**Delete `runDailyDelta` and `BDS_DELTA_MAX_PAGES`.** They cannot work (see
"What the API can and cannot do"), and worse, they fail silently — an
over-deep page is indistinguishable from "no more changes", so the job would
report success while missing 96% of the day's changes.

Replace it with a nightly job over **our own ISBNs**, which we control and can
therefore page through completely, in three priority tiers:

1. **Never asked** — new books from the Gardners ingest. Always first, so a
   newly stocked book gets its bio within a day.
2. **Review gap** — books where Nielsen has answered "no review" and BDS has
   not been asked. This is Part 2.1, and it is where a BDS review adds
   something new.
3. **Oldest checked** — everything else, oldest `checked_at` first, so the
   catalogue refreshes on a rotation. A 30-day rotation over 1.1M books is
   ~37,000 books or ~370 calls a night; a 90-day rotation is ~120 calls.

Tier 3 replaces the delta entirely: instead of asking BDS what changed, we
re-ask about our own books on a cycle. It is simpler, it cannot silently miss
anything, and the cost is trivial.

`BDS_NIGHTLY_ISBN_LIMIT` becomes the rotation dial: 40,000 gives a monthly
refresh, 15,000 a quarterly one.

## 3.3 Ask BDS about the file feed as well

Their ONIX file feed is the right tool for bulk and for genuine change
detection, and it sidesteps the 5,000-record window. Worth having both: the
feed for volume, the API for on-demand lookups of a single book.

---

# Sequencing

| | Work | Size | Depends on |
|---|---|---|---|
| 1 | 3.2 replace the delta with the rotating re-sweep | half a day | — |
| 2 | 3.1 keyset iteration + configurable concurrency | half a day | — |
| 3 | Full catalogue backfill | 2.5–8 hours, unattended | display licence, steps 1–2 |
| 4 | 1.1 per-contributor bios in book detail | half a day | backfill |
| 5 | 1.2–1.3 author bio store + collision guard | 1–2 days | step 4 |
| 6 | 1.4 author endpoint | 1 day + app work | step 5 |
| 7 | 2.3–2.4 Nielsen retune and measurement | half a day | backfill |

Steps 1 and 2 moved ahead of the backfill: running an 8-hour job on code that
is about to be replaced, using a query that degrades as the ledger fills, would
be wasted effort.

## Blocking

**Written confirmation from BDS that we may show this text to readers, store
it, and keep it if the contract ends.** Everything here stores licensed
third-party text and puts it on a public page.

## Questions for BDS

1. Is there a daily or monthly cap, or a fair-use policy, on requests or
   records? Nothing is documented and nothing showed up in testing, but a full
   refresh is ~11,000 requests.
2. Are 4–6 requests in parallel acceptable? It cuts the backfill from 8 hours
   to ~2.5.
3. Is the 5,000-record paging window deliberate? It makes "everything you
   changed yesterday" unanswerable over the API.
4. Can we have the ONIX file feed alongside the API, limited to our ISBNs?
5. Written confirmation of display, storage and post-termination rights.

## Open question for us

Does the app want an author page? Steps 4 and 5 only pay off if there is
somewhere to show an author-level bio. Without one, step 3 alone delivers most
of the value.

## Out of scope

- Author photographs. BDS carry them on 2 of 95 sample products.
- Feeding bios and reviews into recommendation embeddings — needs its own
  licence answer and a re-embedding job in `onix_ingester`.
- Parsing review attributions into structured fields.
- Using `related_editions` to fix the Jellybooks excerpt mismatch. Worth doing,
  but it is a separate piece of work.
