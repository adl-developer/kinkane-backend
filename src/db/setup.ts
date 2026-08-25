/**
 * Post-migration setup: creates the tsvector trigger and GIN indexes that
 * cannot be expressed in Drizzle schema files.
 *
 * Safe to run repeatedly — all statements are idempotent.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';
import { resolveSslMode } from './ssl';
import { COUNTRY_SEED } from './seeds/countries';

const sql = postgres(process.env.DATABASE_URL!, {
  ssl: resolveSslMode(process.env.DATABASE_URL!),
});

async function main() {
  console.log('Running post-migration setup...');

  // ── Full-text search trigger ──────────────────────────────────────────────
  await sql`
    CREATE OR REPLACE FUNCTION update_book_search_vector()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.subtitle, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.isbn13, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.long_description, '')), 'C');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

  await sql`DROP TRIGGER IF EXISTS trg_book_search_vector ON books`;
  await sql`
    CREATE TRIGGER trg_book_search_vector
    BEFORE INSERT OR UPDATE ON books
    FOR EACH ROW EXECUTE FUNCTION update_book_search_vector()
  `;

  // ── Indexes ───────────────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_books_search_vector ON books USING GIN (search_vector)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_books_title_trgm  ON books USING GIN (title gin_trgm_ops)`;

  // Prefix search (title ILIKE 'q%') has no case-insensitive-friendly index today:
  // idx_books_title is a plain (case-sensitive) btree, so ILIKE can't range-scan it —
  // EXPLAIN ANALYZE showed it falling back to a full index-order scan filtering out
  // 800k+ rows one at a time (70s+) for a common prefix. idx_books_title_trgm (GIN) is
  // what actually serves ILIKE today, but for very common words (e.g. "the", matching
  // ~30% of the 1.1M-row table) the index becomes a poor filter — Postgres gets a lossy
  // bitmap back and has to reread and recheck hundreds of thousands of heap pages
  // (~4.3s measured). This functional index lets `lower(title) LIKE lower(q) || '%'`
  // (note: LIKE, not ILIKE — text_pattern_ops only matches the plain LIKE operator) do a
  // genuine indexed range scan instead, independent of how common the prefix is.
  //
  // CONCURRENTLY avoids locking books against reads/writes while this builds against
  // the live table (takes two passes instead of one, and can't run inside a
  // transaction — must stay as its own top-level statement, not batched with others).
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_books_title_lower_pattern ON books (lower(title) text_pattern_ops)`;

  // Author search/suggestions (buildAuthorMatchCondition, authorSuggestions)
  // does ILIKE/word_similarity against book_contributors.person_name — same
  // shape of query as book title search, so it needs the same trigram index.
  //
  // Covers every contributor role, not just authors. These were partial on role = 'A01'
  // on the reasoning that a book's editors, translators and illustrators are not what
  // someone typing a name is looking for. That holds as a *ranking* rule and is kept as
  // one (an A01 match outranks every other role — see buildAuthorMatchSource), but it is
  // wrong as a filter: about one book in five has no A01 contributor at all — edited
  // collections, translated works, illustrated children's books — and under a partial
  // index those are unreachable by name at any spelling. The reported case was an edited
  // volume whose editor is credited B01 and who therefore matched nothing.
  //
  // The role predicate now lives only in the query, where the name match is selective
  // enough that rechecking role against the heap is cheap. The alternative — keeping the
  // A01 partials alongside these — buys a marginally tighter scan for common name
  // fragments at the cost of four indexes to maintain on a table that ingestion bulk
  // loads into. Not worth it until a measurement says otherwise.
  //
  // Note the new names. The predicate is part of an index's definition, not something
  // CREATE INDEX IF NOT EXISTS will reconcile — against a database that already has the
  // partial index, re-running the statement under its old name is a silent no-op and the
  // widened definition never lands. Hence distinct names, with the superseded indexes
  // dropped below once these exist.
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_book_contributors_name_trgm ON book_contributors USING GIN (person_name gin_trgm_ops)`;
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_book_contributors_person_name_trgm`;
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_book_contributors_author_name_trgm`;

  // The author-name counterpart of idx_books_title_lower_pattern above, and it exists
  // for the same reason: the trigram index serves ILIKE, but for a common name fragment
  // ("jo", "sm") it becomes a poor filter and Postgres falls back to rechecking a large
  // number of heap pages. This functional index gives `lower(person_name) LIKE lower(q||'%')`
  // a genuine indexed range scan instead, which is what orders the bounded candidate set
  // in buildAuthorMatchCondition — the step that decides which matches survive its LIMIT.
  // Same caveats as the title version: plain LIKE only (text_pattern_ops matches no other
  // operator), and CONCURRENTLY so it builds without locking the table against writes.
  // Widened off role = 'A01' for the same reason as the trigram index above.
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_book_contributors_name_lower_pattern ON book_contributors (lower(person_name) text_pattern_ops)`;
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_book_contributors_author_name_lower_pattern`;

  // ANN index for the "similar"/"personalized" cosine-distance (<=>) queries.
  // Without this, ORDER BY embedding <=> vector is a brute-force scan that
  // computes distance against every embedded row. HNSW needs no row-count
  // tuning (unlike ivfflat's `lists` parameter) so it stays correct as the
  // catalogue grows from ongoing Gardners ingestion.
  //
  // maintenance_work_mem defaults to 64MB, which the in-progress HNSW graph
  // outgrows well before the full `books` table is indexed — past that point
  // Postgres falls back to a much slower disk-assisted build for every
  // remaining row. Raised here for just this session/connection (setup.ts
  // closes it right after, so nothing else is affected); 256MB comfortably
  // fits the 2GB DigitalOcean "Basic" plan this runs against today alongside
  // shared_buffers and other concurrent connections — revisit if the plan
  // changes size.
  await sql`SET maintenance_work_mem = '256MB'`;
  // Parallel index builds coordinate workers through a dynamic shared-memory
  // segment sized roughly in proportion to maintenance_work_mem — on this
  // managed instance that segment request exceeded available shared-memory
  // space once maintenance_work_mem was raised (`could not resize shared
  // memory segment ... No space left on device`). Disabling parallel workers
  // for this one statement avoids needing that segment at all; the build
  // runs single-threaded instead, still with the larger memory budget above.
  await sql`SET max_parallel_maintenance_workers = 0`;
  await sql`CREATE INDEX IF NOT EXISTS idx_books_embedding_hnsw ON books USING hnsw (embedding vector_cosine_ops)`;

  // ── Country reference data ────────────────────────────────────────────────
  // Seeded here rather than in a migration so it stays correctable: a continent
  // assignment is a scoring rule (10 points vs 20), and re-running setup is the
  // supported way to fix one. Upsert on the name/continent so an existing row is
  // corrected rather than skipped, which ON CONFLICT DO NOTHING would do.
  await sql`
    INSERT INTO countries ${sql(COUNTRY_SEED, 'code', 'name', 'continent')}
    ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name, continent = EXCLUDED.continent
  `;
  console.log(`Seeded ${COUNTRY_SEED.length} countries.`);

  console.log('Setup complete.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
