# Book pages show review quotes and awards from the publisher's description

## What changed

Publishers often put review material inside a book's long description, run together with the blurb:
- press quotes ("'Gripping' — The Times")
- author blurbs ("'An extraordinary book' JILL MANSELL")
- reader reviews ("Goodreads reviewer, ⭐⭐⭐⭐⭐")
- awards ("#1 NEW YORK TIMES BESTSELLER", "Shortlisted for the Costa Book Award")

These are now extracted and shown in the book page's existing review section, as a new review source, `publisher`.

No API shape changed. `GET /books/:id` returns them in the `review` object it already had, with `review.source` set to `publisher`. Nielsen and BDS reviews, where present, still win: the order is Nielsen, then BDS, then publisher. The long description itself is left as it is, so a quote can appear in both places.

## Why

The BDS and Nielsen review data is being removed, which would leave almost every book page without reviews. Gardners' ONIX feed has no separate review-quote field (TextType 08). A sample file carries only 02, 03 and 06, so the long description is the only place these quotes reach us. A read-only scan of production on 13 Oct 2026:

| | Books |
|---|---|
| Long descriptions checked | 1,650,448 |
| Rules found review material | 91,303 |
| Handed to the LLM | about 22,000 (1.3%) |
| Expected to end up with a review | about 96,000 |

The scan itself counted 20,864 for the LLM. A final rules fix sends a few more borderline descriptions to it, and the 1-in-20 sample run through the full pipeline afterwards puts the total at about 22,000. The last row is scaled up from that same sample.

## How it works

**Extraction** (`src/lib/publisher-reviews.ts`) is pure code: no database, no network.

1. **Clean the text.** Remove markup, decoding repeatedly because some feed text is entity-encoded more than once. Fix the SQL-style doubled quotes (`Williams''s`) that leaked into the feed. Shared with the supplier review splitter script through `src/lib/review-text.ts`.
2. **Rules.** Find quotes with a source after them: after a dash, an all-caps name, a name in brackets, or the next paragraph. Also find "Praise for…" and "What readers are saying" sections, star-rated reader lines, and award or bestseller lines. The quote scanner tracks nested quotes and tells apostrophes from closing quote marks.
3. **Routing.** The rules also look for review-shaped text they did not account for, such as a quote, then a dash, then a name, outside anything they extracted. If they find any, the description goes to Gemini. Non-English descriptions with that shape go too.
4. **LLM.** `extractReviewItems` in `src/lib/gemini.ts` uses the existing flash-lite model, retry and fallback, and a response schema. The model returns `{ kind, quote, attribution }` items.
5. **Validation, for both paths.**
   - Every quote and source must appear word for word in the description. This is what stops a model inventing or rewording one.
   - A quote needs a source, unless a praise heading or star rating vouches for it. Unattributed quotes in these descriptions are as often lines from the book.
   - A "source" that reads like a sentence ("Chernow writes", "…is available now") is rejected.
6. **Output.** Plain text, no HTML: awards first, one per line, then each "quote" with its source on the next line after `— `, with a blank line between items. The column keeps its name, `review_html`, as does the API's `reviewHtml` field.

**Storage.** Only books with reviews get a row: one `book_reviews` row with `source = 'publisher'`, never with an empty `review_html`. A book whose description has no reviews has no row, and a row is deleted when a changed description no longer has any. The row stores:
- `source_field`: `rules`, `llm`, or `rules_fallback` (the LLM was wanted but unavailable or unusable)
- a new `source_hash` column (migration 0079): the md5 of the description it was read from, after `toCleanDescription`. Hashing the cleaned text means that removing HTML from the stored descriptions later does not make every book look changed.

**Keeping it current.**
- `scripts/publisher-reviews-backfill.ts` walks the whole catalogue once.
  - It skips books whose reviews were read from the same description.
  - Books without reviews have no row recording that they were checked, so a re-run checks them again. The rules are cheap, so this costs little.
  - A stopped run resumes with `--after-id`, using the `lastId` it printed.
  - `--retry-fallback` re-runs the `rules_fallback` books, and `--force` redoes everything after a rules change. `--no-llm` runs rules only.
- A nightly cron (`PUBLISHER_REVIEWS_CRON`, default 04:00, off unless `PUBLISHER_REVIEWS_ENABLED=true`) re-extracts books whose `updated_at` moved since the last successful run and whose hash no longer matches. It uses a Redis lock and watermark, like the BDS job.
- Changed reviews drop their cached book page.

**Nielsen on-demand lookups.** The book page asks Nielsen for a review when it has none. A publisher review now fills that field, so the trigger changed from "no review" to "no Nielsen or BDS review". Otherwise Nielsen would never be asked about those books. It still does nothing while Nielsen is disabled.

## Decisions worth knowing

- **Rules first, LLM second.** On the local catalogue the rules handle 98% of descriptions in about 9 seconds for 75k books. The LLM takes about 1.2 s per call. Sending everything to it would cost far more for a small gain.
- **Verbatim validation over trusting the model.** Flash-lite was seen including letters quoted inside a local-history book as if they were blurbs. The check cannot catch that, because the words are really there, but it does stop anything invented.
- **Awards count, praise of the author doesn't.** "From the bestselling author of…", "award-winning" compounds, foreword credits and sentences that merely mention a prize are rejected. In random samples of extracted award lines, false positives went from 5 in 40 to 2 in 30, and both of those have since been fixed.
- **A row of asterisks is not a star rating.** In these descriptions it is as often a section break.

## Left out of scope

- Removing the quotes from the displayed long description.
- Showing several sources at once. The service still picks one per book.
- Known misses the rules and model still make:
  - quotes from a book's subject or an epigraph that look exactly like blurbs (Martin Luther King Jr. on a picture book about him);
  - occasionally, letters or diary lines in history books.

## How it was verified

- **Unit tests:** 35 in `src/__tests__/publisher-reviews.test.ts`, built from real descriptions found while sizing this. They cover cleaning, each attribution layout, excerpts and whole-blurb quotes that must not count, star ratings, awards, routing, validation, the plain-text output and the LLM fallbacks.
- **Integration tests:** 10 in `src/__tests__/publisher-reviews.integration.test.ts`, against a real Postgres. They cover:
  - that only books with reviews get a row, and none has an empty review;
  - that a re-run skips books with reviews and re-checks the rest;
  - resuming after a book id;
  - LLM routing, validation and `rules_fallback` retry, and `--force`;
  - ranking against Nielsen and BDS;
  - nightly re-extraction, and deleting the row of a description that lost its reviews, with cache invalidation;
  - the watermark and the lock.
  The BDS and Nielsen integration suites still pass with the shared store change.
- **Full suites:** the unit suite and the endpoint contract suite pass.
- **Local backfill:** 75,095 descriptions in 5.0 minutes, 7,238 with reviews, 1,655 LLM calls. A re-run re-checked the 67,857 books without reviews in 1.2 minutes (175 LLM calls) and wrote nothing. `GET /books/:id` served publisher reviews, and BDS still won where both exist.
- **Precision:** checked by reading random samples of awards, quotes and LLM output from the local run and from the production sample. The final production sample read about 37 of 40 items correct before the last rules fix.
