# Plan: author biographies, and review quotes where Nielsen has none

**Written 2026-09-25**, after the BDS licence was attached and the API measured
against the real catalogue. Companion to
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

A live sweep of 200 books took 5.5 seconds, so the full catalogue is 2–3 hours.

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

# Sequencing

| | Work | Size | Depends on |
|---|---|---|---|
| 1 | Full catalogue backfill (`scripts/bds-backfill.ts`) | 2–3 hours, unattended | display licence |
| 2 | 2.1 gap-first sweep | half a day | — |
| 3 | 1.1 per-contributor bios in book detail | half a day | backfill |
| 4 | 1.2–1.3 author bio store + collision guard | 1–2 days | 1.1 |
| 5 | 1.4 author endpoint | 1 day + app work | 1.2 |
| 6 | 2.3–2.4 Nielsen retune and measurement | half a day | backfill |

## Blocking

**Written confirmation from BDS that we may show this text to readers, store
it, and keep it if the contract ends.** Everything here stores licensed
third-party text and puts it on a public page.

## Open question

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
