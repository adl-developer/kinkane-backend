/**
 * Builds the indexes that are too big to create under a lock, before
 * `drizzle-kit migrate` runs.
 *
 * Some indexes in drizzle/ are declared `CREATE INDEX IF NOT EXISTS` against
 * tables large enough that building them inline is an outage in miniature: a
 * plain CREATE INDEX takes a SHARE lock for the length of the build, and on
 * ~2M-row `books` that stalls every writer — the ONIX chunk pipeline, a
 * COPY-to-staging merge, a Gardners feed run — until it finishes.
 *
 * This runs the same indexes CONCURRENTLY first. The migration then finds them
 * present, its IF NOT EXISTS makes it a no-op, and nothing ever takes the lock.
 * CONCURRENTLY cannot live in the migration itself because it is illegal inside
 * a transaction block and drizzle-kit wraps migrations in one — which is the
 * only reason this file exists.
 *
 * Everything here is idempotent and safe to run on every deploy: for an index
 * that is already present and valid it costs one catalog query.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';
import { resolveSslMode } from './ssl';

/**
 * The CONCURRENTLY twin of an index declared in drizzle/.
 *
 * `sql` must describe exactly the same index as the migration's statement —
 * for an expression index, character-identical in the expression, or Postgres
 * builds a second index the planner will never match to the query and the
 * migration goes on to build the real one under a lock anyway.
 */
interface ConcurrentIndex {
  name: string;
  table: string;
  /** The migration this mirrors, for the log line when something needs chasing. */
  migration: string;
  /**
   * Set when the index covers a column its migration *adds*. This step runs
   * before `drizzle-kit migrate`, so on the deploy that first introduces the
   * column there is nothing here to index yet — without this the build throws
   * and the (non-fatal) handler logs a failure for something that is working
   * exactly as intended.
   */
  column?: string;
  sql: string;
}

const TITLE_JUNK_RANK = `(CASE WHEN "title" ~ '[[:alnum:]]' THEN 0 ELSE 1 END)`;

const INDEXES: ConcurrentIndex[] = [
  {
    name: 'idx_books_title_sortable',
    table: 'books',
    migration: '0056_books_title_sortable_index',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_books_title_sortable" ON "books" USING btree (${TITLE_JUNK_RANK}, "title")`,
  },
  {
    // Separate from its ASC sibling because the placeholder rank stays ASC while
    // the title flips, so `sort=desc` is not a backwards read of the other one.
    // See buildSortOrderBy in services/books.service.ts.
    name: 'idx_books_title_sortable_desc',
    table: 'books',
    migration: '0056_books_title_sortable_index',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_books_title_sortable_desc" ON "books" USING btree (${TITLE_JUNK_RANK}, "title" DESC)`,
  },
  {
    // The admin console filters and counts on last_sign_in_at on every
    // Customers and Overview load. `users` is far smaller than `books`, but a
    // plain build still takes a SHARE lock, and the writers it would stall are
    // sign-ins — so the one table where a lock is most visible to a customer.
    name: 'idx_users_last_sign_in_at',
    table: 'users',
    migration: '0057_user_last_sign_in',
    column: 'last_sign_in_at',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_last_sign_in_at" ON "users" USING btree ("last_sign_in_at")`,
  },
  {
    // GET /books?mainGenre= filters on this and then reads in the list's default
    // updated_at order, which the second column serves — so the whole page is one
    // scan. `books` is the largest table here (~2M rows) and its writers are the
    // ONIX chunk pipeline and the Gardners feed runs, so this is the build most
    // worth keeping off a lock.
    //
    // The bare ascending updated_at and the WHERE are both load-bearing, and
    // both must match drizzle/0060 character for character. A partial index is
    // a different index from a full one, and `DESC NULLS LAST` is a different
    // ordering from the default listing's bare ASC — either mismatch describes
    // something other than the migration's index, and IF NOT EXISTS, which
    // matches on name and not definition, would hide it: the migration would
    // skip, and the planner would sort on top of whatever got built.
    name: 'idx_books_main_genre',
    table: 'books',
    migration: '0060_books_main_genre',
    column: 'main_genre_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_books_main_genre" ON "books" USING btree ("main_genre_id", "updated_at") WHERE "books"."is_removed" = false`,
  },
];

const sql = postgres(process.env.DATABASE_URL!, {
  ssl: resolveSslMode(process.env.DATABASE_URL!),
  // A build over a few million rows is measured in minutes, and this connection
  // does nothing else. Whatever statement_timeout the role carries would kill it
  // partway and leave an invalid index behind.
  idle_timeout: 0,
  max: 1,
});

/** `null` when absent; otherwise whether Postgres considers it usable. */
async function indexState(name: string): Promise<{ valid: boolean } | null> {
  const rows = await sql<{ indisvalid: boolean }[]>`
    SELECT i.indisvalid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = ${name}
  `;
  return rows.length ? { valid: rows[0]!.indisvalid } : null;
}

async function tableExists(table: string): Promise<boolean> {
  const [row] = await sql<{ oid: string | null }[]>`
    SELECT to_regclass(${table}) AS oid
  `;
  return Boolean(row?.oid);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    SELECT 1 AS n
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

async function build(index: ConcurrentIndex): Promise<void> {
  // .simple() because CREATE INDEX CONCURRENTLY is rejected under the extended
  // query protocol postgres.js uses by default.
  await sql.unsafe(index.sql).simple();
}

/**
 * A CONCURRENTLY build that fails partway leaves the index in place and
 * *invalid*: the planner will not use it, and — the trap this function exists
 * for — it is still enough to satisfy the migration's IF NOT EXISTS. Left
 * alone, the deploy would skip past it and the endpoint would be quietly slow
 * with no error anywhere. Dropping it puts the migration back in charge.
 */
async function dropInvalid(index: ConcurrentIndex): Promise<void> {
  await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`).simple();
}

async function ensure(index: ConcurrentIndex): Promise<void> {
  if (!(await tableExists(index.table))) {
    // A database new enough not to have the table yet: the migration will create
    // it and the index together, on a table with nothing in it to lock.
    console.log(`  ${index.name}: ${index.table} does not exist yet, leaving it to ${index.migration}`);
    return;
  }

  if (index.column && !(await columnExists(index.table, index.column))) {
    // The deploy that introduces the column: it does not exist until the
    // migration runs, a few seconds from now, which then builds the index
    // itself. Every later deploy takes the concurrent path above.
    console.log(
      `  ${index.name}: ${index.table}.${index.column} does not exist yet, leaving it to ${index.migration}`,
    );
    return;
  }

  const existing = await indexState(index.name);
  if (existing?.valid) {
    console.log(`  ${index.name}: already built`);
    return;
  }
  if (existing) {
    console.warn(`  ${index.name}: found invalid (a previous build failed), dropping and rebuilding`);
    await dropInvalid(index);
  }

  console.log(`  ${index.name}: building concurrently, this can take several minutes...`);
  const started = Date.now();
  await build(index);
  console.log(`  ${index.name}: built in ${Math.round((Date.now() - started) / 1000)}s`);
}

async function main() {
  console.log('Pre-building concurrent indexes...');
  for (const index of INDEXES) {
    try {
      await ensure(index);
    } catch (err) {
      // Deliberately not fatal. Every index here is also declared in a migration,
      // so failing this step costs availability, never correctness: the migration
      // builds it under a lock instead and the deploy stalls the writers it was
      // meant to spare. That is a worse deploy, not a broken one — and a failure
      // to build an index must not be what stops a release going out.
      //
      // The drop matters more than the build: it is what stops a half-built
      // index from satisfying the migration's IF NOT EXISTS.
      console.error(
        `  ${index.name}: concurrent build failed, ${index.migration} will build it under a lock instead`,
        err,
      );
      try {
        await dropInvalid(index);
      } catch (dropErr) {
        console.error(
          `  ${index.name}: could not drop the failed index either — the migration will skip it and the index will be UNUSED. Drop it by hand: DROP INDEX CONCURRENTLY "${index.name}";`,
          dropErr,
        );
      }
    }
  }
  console.log('Concurrent indexes done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});
