/**
 * Fills books.main_genre_id for the existing catalogue (phase 2 of the main
 * genre rollout).
 *
 *   npx tsx scripts/backfill-main-genre.ts --dry-run     # count, write nothing
 *   npx tsx scripts/backfill-main-genre.ts               # localhost
 *   npx tsx scripts/backfill-main-genre.ts --yes         # required off localhost
 *   npx tsx scripts/backfill-main-genre.ts --from 812000 # resume after a stop
 *
 * Two passes, in order:
 *
 *   primary   The publisher's own nomination — the scheme-93 row in
 *             book_subjects carrying is_main_subject. Measured on production
 *             2026-09-04 this covers 1,415,382 of 2,029,071 live books, with
 *             exactly one such code per book, so there is nothing to tie-break.
 *
 *   fallback  Books that have genres but no nomination (4,474 on the same
 *             measurement) and hold exactly one genre: that genre is the main
 *             one by definition. A book with several genres and no nomination
 *             is left NULL rather than guessed at.
 *
 * Deliberately NOT the most frequent of a book's genres. Thema codes are
 * hierarchical, so the commonest genre on a book is always its broadest
 * ancestor, and that rule disagrees with the publisher's nomination on 37% of
 * books (production, 1,412,951 comparable).
 *
 * Safe to interrupt and safe to re-run. Batches are keyset ranges over
 * books.id, each its own transaction, and every UPDATE carries an
 * `IS DISTINCT FROM` guard so a second pass over settled rows writes nothing
 * and creates no dead tuples. `--from` resumes at a known id; without it the
 * run starts from the beginning, which is cheap for the same reason.
 *
 * Withdrawn books (is_removed) are backfilled too. They are absent from the
 * partial index and from every listing, but the flag clears when Gardners
 * reissues a title — and a reissued book should not come back genre-less.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';
import { resolveSslMode } from '../src/db/ssl';

const DEFAULT_BATCH = 25_000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DRY_RUN = flag('dry-run');
const BATCH = num('batch', DEFAULT_BATCH);
const FROM = num('from', 0);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const host = new URL(url).hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1';

// Off localhost this rewrites a column on every row of a ~2M-row table. That
// should never happen because a command was recalled from shell history.
if (!isLocal && !DRY_RUN && !flag('yes')) {
  console.error(
    `\nRefusing to write to ${host} without --yes.\n` +
      `This backfills books.main_genre_id across the whole catalogue.\n` +
      `Re-run with --yes if that is what you meant, or --dry-run to see the counts.\n`,
  );
  process.exit(1);
}

const sql = postgres(url, {
  ssl: resolveSslMode(url),
  max: 1,
  // Batches are measured in seconds, and this connection does nothing else.
  idle_timeout: 0,
});

/**
 * Whether drizzle/0060 has reached this database.
 *
 * A dry run has to work *before* the migration ships — previewing the counts is
 * most of the reason to run one, and on a database without the column every
 * book is trivially unset. So the column reference becomes a NULL literal
 * there, which makes `IS DISTINCT FROM` and `IS NULL` behave exactly as they
 * would against a freshly-added, entirely-NULL column. Writing, by contrast,
 * is refused outright — there is nowhere to put the answer.
 */
let hasColumn = true;

/** `b.main_genre_id`, or a NULL standing in for it before 0060 lands. */
function mainGenre() {
  return hasColumn ? sql`b.main_genre_id` : sql`NULL::int`;
}

interface PassResult {
  updated: number;
  batches: number;
}

/**
 * Walks books.id in keyset ranges, handing each range to `run`.
 *
 * The bound query takes the max id of the next `BATCH` rows rather than adding
 * BATCH to the last id: book ids are sparse (deletes, failed inserts), so a
 * fixed stride would make the batch size drift with the gaps.
 */
async function eachRange(
  label: string,
  run: (lo: number, hi: number) => Promise<number>,
): Promise<PassResult> {
  let lo = FROM;
  let updated = 0;
  let batches = 0;
  const started = Date.now();

  for (;;) {
    const [bound] = await sql<{ hi: number | null }[]>`
      SELECT max(id) AS hi
      FROM (SELECT id FROM books WHERE id > ${lo} ORDER BY id LIMIT ${BATCH}) t
    `;
    const hi = bound?.hi;
    if (hi === null || hi === undefined) break;

    const n = await run(lo, hi);
    updated += n;
    batches += 1;

    if (batches % 10 === 0 || n > 0) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(
        `  ${label}: batch ${batches} · ids ${lo + 1}-${hi} · ${n} rows · ${updated} total · ${secs}s`,
      );
    }

    lo = hi;
  }

  return { updated, batches };
}

/**
 * The publisher's nomination.
 *
 * DISTINCT ON is belt-and-braces: subject_code is one-to-one with a genre on
 * both databases as of 2026-09-04, and a book carries exactly one scheme-93
 * main subject. If either ever stops being true this picks the lowest genre id
 * rather than letting Postgres choose a row arbitrarily per batch, which would
 * make re-runs churn.
 */
async function primaryPass(lo: number, hi: number): Promise<number> {
  if (DRY_RUN) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM books b
      JOIN LATERAL (
        SELECT g.id AS genre_id
        FROM book_subjects bs
        JOIN genres g ON g.subject_code = bs.subject_code AND g.scheme_identifier = '93'
        WHERE bs.book_id = b.id AND bs.is_main_subject AND bs.scheme_identifier = '93'
        ORDER BY g.id
        LIMIT 1
      ) m ON true
      WHERE b.id > ${lo} AND b.id <= ${hi}
        AND ${mainGenre()} IS DISTINCT FROM m.genre_id
    `;
    return row?.n ?? 0;
  }

  const rows = await sql`
    UPDATE books b
    SET main_genre_id = m.genre_id
    FROM (
      SELECT DISTINCT ON (bs.book_id) bs.book_id, g.id AS genre_id
      FROM book_subjects bs
      JOIN genres g ON g.subject_code = bs.subject_code AND g.scheme_identifier = '93'
      WHERE bs.is_main_subject
        AND bs.scheme_identifier = '93'
        AND bs.book_id > ${lo} AND bs.book_id <= ${hi}
      ORDER BY bs.book_id, g.id
    ) m
    WHERE b.id = m.book_id
      AND b.main_genre_id IS DISTINCT FROM m.genre_id
  `;
  return rows.count;
}

/** Exactly one genre and no nomination: that genre is the main one. */
async function fallbackPass(lo: number, hi: number): Promise<number> {
  if (DRY_RUN) {
    // A dry run writes nothing, so pass 1's rows are still NULL here and a
    // naive count would report them again — the two passes would appear to
    // cover more than the catalogue holds. Exclude anything pass 1 would have
    // taken, so the number printed is the incremental one.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM books b
      JOIN (
        SELECT bg.book_id, min(bg.genre_id) AS genre_id
        FROM book_genres bg
        WHERE bg.book_id > ${lo} AND bg.book_id <= ${hi}
        GROUP BY bg.book_id
        HAVING count(*) = 1
      ) s ON s.book_id = b.id
      WHERE ${mainGenre()} IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM book_subjects bs
          JOIN genres g ON g.subject_code = bs.subject_code AND g.scheme_identifier = '93'
          WHERE bs.book_id = b.id AND bs.is_main_subject AND bs.scheme_identifier = '93'
        )
    `;
    return row?.n ?? 0;
  }

  const rows = await sql`
    UPDATE books b
    SET main_genre_id = s.genre_id
    FROM (
      SELECT bg.book_id, min(bg.genre_id) AS genre_id
      FROM book_genres bg
      WHERE bg.book_id > ${lo} AND bg.book_id <= ${hi}
      GROUP BY bg.book_id
      HAVING count(*) = 1
    ) s
    WHERE b.id = s.book_id
      AND b.main_genre_id IS NULL
  `;
  return rows.count;
}

async function report(): Promise<void> {
  if (!hasColumn) {
    const [row] = await sql<{ total: number; live: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE is_removed = false)::int AS live
      FROM books
    `;
    if (!row) return;
    console.log(`  books:            ${row.total.toLocaleString()}`);
    console.log(`  live books:       ${row.live.toLocaleString()}`);
    console.log(`  with main genre:  n/a — 0060 has not reached this database`);
    return;
  }

  const [row] = await sql<{ total: number; filled: number; live: number; live_filled: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE main_genre_id IS NOT NULL)::int AS filled,
           count(*) FILTER (WHERE is_removed = false)::int AS live,
           count(*) FILTER (WHERE is_removed = false AND main_genre_id IS NOT NULL)::int AS live_filled
    FROM books
  `;
  if (!row) return;
  const pct = row.live ? ((100 * row.live_filled) / row.live).toFixed(2) : '0.00';
  console.log(`  books:            ${row.total.toLocaleString()}`);
  console.log(`  with main genre:  ${row.filled.toLocaleString()}`);
  console.log(`  live books:       ${row.live.toLocaleString()}`);
  console.log(`  live covered:     ${row.live_filled.toLocaleString()} (${pct}%)`);
}

async function main(): Promise<void> {
  console.log(`\nBackfilling books.main_genre_id`);
  console.log(`  target:  ${host}${isLocal ? ' (local)' : ''}`);
  console.log(`  mode:    ${DRY_RUN ? 'DRY RUN — nothing is written' : 'writing'}`);
  console.log(`  batch:   ${BATCH.toLocaleString()} books`);
  if (FROM > 0) console.log(`  from id: ${FROM}`);

  const [col] = await sql<{ n: number }[]>`
    SELECT 1 AS n FROM information_schema.columns
    WHERE table_name = 'books' AND column_name = 'main_genre_id'
  `;
  hasColumn = Boolean(col);

  if (!hasColumn) {
    if (!DRY_RUN) {
      console.error(
        `\n  books.main_genre_id does not exist on ${host}.\n` +
          `  Deploy drizzle/0060_books_main_genre before backfilling it.\n` +
          `  (--dry-run works without it and will report what the backfill would set.)\n`,
      );
      await sql.end();
      process.exit(1);
    }
    console.log(`  column:  absent — 0060 not deployed here, counting as if all NULL`);
  }

  console.log('\nBefore:');
  await report();

  console.log('\nPass 1 — publisher nomination');
  const primary = await eachRange('primary', primaryPass);
  console.log(`  ${DRY_RUN ? 'would set' : 'set'} ${primary.updated.toLocaleString()} in ${primary.batches} batches`);

  console.log('\nPass 2 — single-genre fallback');
  const fallback = await eachRange('fallback', fallbackPass);
  console.log(`  ${DRY_RUN ? 'would set' : 'set'} ${fallback.updated.toLocaleString()} in ${fallback.batches} batches`);

  if (!DRY_RUN) {
    // The planner has no statistics for a column that was entirely NULL when it
    // last looked, and phase 1's index is useless until it does.
    console.log('\nANALYZE books...');
    await sql.unsafe('ANALYZE books');
  }

  console.log('\nAfter:');
  await report();
  console.log('');
}

main()
  .then(async () => {
    await sql.end();
  })
  .catch(async (err) => {
    console.error('\nBackfill failed:', err);
    // Batches commit as they go, so the work already done stands. The id in the
    // last progress line is where --from should pick up.
    await sql.end();
    process.exit(1);
  });
