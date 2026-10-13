# Book descriptions are plain text, without HTML

## What changed

Publisher long descriptions arrive from the Gardners feed as HTML: paragraph and bold tags, line breaks, entities like `&amp;` and `&#8217;`. Some are even HTML encoded inside HTML (`&lt;b&gt;Praise&lt;/b&gt;`). `GET /books/:id` now returns them as plain text that keeps the layout:

| Before | After |
|---|---|
| `<p>…</p><p>…</p>` | paragraphs separated by a blank line |
| `<br>` | a line break |
| `<ul><li>Maps</li><li>Recipes</li></ul>` | `• Maps` / `• Recipes` on their own lines |
| `&amp;`, `&#8217;`, `&lt;b&gt;` | `&`, `’`, removed |
| `Williams''s` (a feed bug) | `Williams's` |

The field (`longDescription`) and its type are unchanged. The cleaning happens when the description is returned; the stored text is left as the feed sent it (see "Why clean on the way out" below).

## How

- **`toCleanDescription`** in `src/lib/review-text.ts` does the cleaning. It runs strip-and-decode rounds until nothing changes, so double-encoded markup goes too. It also drops the runs of spaces some feeds pad after every entity, which would otherwise turn `Wainwright&#8217;   s` into `Wainwright’ s`. Running it on clean text returns it unchanged.
- **The book page cleans on the way out.** `getById` runs `toCleanDescription` on the stored text before returning it, so the API never returns markup, including for books the importer adds later.
- **`scripts/clean-long-descriptions.ts`** can also rewrite the stored descriptions, for a later maintenance window.
  - It only reads rows with a tag, an entity or `''`, and only writes rows whose text actually changes.
  - Every original is written to a gzipped JSONL backup *before* its row is updated, and `--restore FILE` puts them all back.
  - `--dry-run` shows before/after samples, and `--after-id` resumes a stopped run.
  - It leaves `updated_at` alone. This is a formatting change, not new data from the publisher, so the nightly jobs should not treat every cleaned book as changed.
  - On production, 645,882 descriptions had tags and 149,090 had entities, out of 2.05M books.

## Why clean on the way out, not in the database

The rewrite was started on production and stopped after 2,000 rows. Each rewritten row is re-inserted into all 17 indexes on `books`, including the HNSW vector index over 768-dimension embeddings. On production that meant random disk reads at about 165 ms per row: about 30 hours of heavy disk load for the ~650,000 rows with markup. Cleaning on read gives the same result to every client, with no database load.

- **What production holds now:** 2,000 descriptions (book ids up to 5,860) are stored cleaned; the rest are unchanged. Their originals are in `backups/long-description-backup-prod-2026-10-13.repaired.jsonl.gz`.
- **Doing the rewrite later:** resume with `--after-id 5860` in a quiet window. Dropping and rebuilding the HNSW index around it would make it far faster, but vector search is slow until the index is back.
- **No effect on publisher reviews:** their description hash is taken from the cleaned text, so a later rewrite does not mark every book as changed.
- **Stopping safely:** an early stop was by signal, which left the backup's gzip stream without its trailer. The script now finishes the batch in flight and closes the backup on Ctrl-C.

## Decisions worth knowing

- **Layout is kept, not flattened.** Paragraphs, line breaks and list items carry meaning in these descriptions, such as praise sections and contents lists. They become blank lines, new lines and bullets rather than one run-on paragraph.
- **A description that was only markup becomes NULL**, not an empty string. That was 8 rows on the local catalogue.
- **Backups escape U+2028/U+2029.** Some descriptions contain these characters raw. They are valid inside JSON, but Node's line reader treats them as line breaks, which broke an early restore test. The restore now splits on `\n` only, so backups written before this fix still restore.

## Left out of scope

- **The importer.** Stripping HTML at import in `onix_ingester` would keep new data clean at the source. Cleaning on read already covers the API, and that repo has uncommitted work in progress in its parser, so it is a separate change.
- **Short descriptions.** They can contain HTML too, and were not touched.

## How it was verified

- **Unit tests:** 8 in `src/__tests__/review-text.test.ts`. They cover paragraphs, line breaks, inline tags, entities, double-encoded markup, list bullets, the doubled-quote repair, the entity space runs, idempotence and markup-only input.
- **Local catalogue:**
  - 38,249 descriptions cleaned in 2–3 minutes. A second run changed nothing.
  - A full restore from the backup brought back all 38,249 originals byte for byte, and cleaning again changed the same 38,249.
