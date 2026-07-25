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

  // Author search/suggestions (buildAuthorBookSearchCondition, authorSuggestions)
  // does ILIKE/word_similarity against book_contributors.person_name — same
  // shape of query as book title search, so it needs the same trigram index.
  await sql`CREATE INDEX IF NOT EXISTS idx_book_contributors_person_name_trgm ON book_contributors USING GIN (person_name gin_trgm_ops)`;

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

  console.log('Setup complete.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
