/**
 * Side-by-side comparison of NielsenIQ BookData and BDS, on the same books
 * and the same authors.
 *
 *   npx tsx scripts/nielsen-bds-comparison.ts [--books 500] [--authors 100]
 *
 * BDS data is read from what the backfill already stored. Nielsen is fetched
 * live, one record per book, and **spends the Nielsen daily allowance** — the
 * defaults cost 600 of the account's 1,000 records for the day. Each lookup
 * claims from nielsen_api_usage first, so the ledger stays honest and the
 * script stops rather than overspending.
 *
 * Nielsen's Long view carries both fields we care about:
 *   NBDFREV  — review quotes        (BDS: `review`)
 *   NBDFBIOG — contributor biography (BDS: `author_bio`)
 *
 * Writes two CSVs to probe-output/ (git-ignored, because both suppliers'
 * text is licensed).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db';
import { redis } from '../src/lib/redis';
import { claimBudget } from '../src/services/book-reviews.service';
import { bioSimilarity } from '../src/services/author-bios.service';

function numberArg(flag: string, fallback: number): number {
  const at = process.argv.indexOf(flag);
  return at > -1 ? Number(process.argv[at + 1]) : fallback;
}

const BOOK_COUNT = numberArg('--books', 500);
const AUTHOR_COUNT = numberArg('--authors', 100);
const outDir = join(__dirname, '../probe-output', `comparison-${new Date().toISOString().slice(0, 10)}`);

// ── Nielsen ─────────────────────────────────────────────────────────────────

const RESULT_COMPLETED = '00';
const RESULT_LIMITS_EXCEEDED = '50';

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const text = decodeEntities(match[1]).trim();
  if (!text || text.toLowerCase().startsWith('no reviews available')) return null;
  return text;
}

interface NielsenRecord {
  review: string | null;
  bio: string | null;
  found: boolean;
}

/** One Nielsen record: review and biography, from the Long view. */
async function fetchNielsen(isbn13: string): Promise<NielsenRecord | 'budget-spent'> {
  if (!(await claimBudget('batch'))) return 'budget-spent';

  const url = new URL(config.nielsen.baseUrl);
  url.searchParams.set('clientId', config.nielsen.clientId ?? '');
  url.searchParams.set('password', config.nielsen.password ?? '');
  url.searchParams.set('from', '0');
  url.searchParams.set('to', '1');
  url.searchParams.set('indexType', '0');
  url.searchParams.set('format', '7');
  url.searchParams.set('resultView', '2');
  url.searchParams.set('territory', config.nielsen.territory);
  url.searchParams.set('field0', '1');
  url.searchParams.set('value0', isbn13);

  const body = await fetch(url).then((r) => r.text());
  const resultCode = extractTag(body, 'resultCode');
  if (resultCode === RESULT_LIMITS_EXCEEDED) return 'budget-spent';
  if (resultCode !== RESULT_COMPLETED) return { review: null, bio: null, found: false };

  return {
    // Territory variants: only one is ever populated.
    review: extractTag(body, 'NBDFREV') ?? extractTag(body, 'AUSFREV') ?? extractTag(body, 'NZFREV'),
    bio: extractTag(body, 'NBDFBIOG'),
    found: /<ISBN13>/.test(body),
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path: string, header: string[], rows: unknown[][]): void {
  writeFileSync(path, [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n'));
}

const chars = (v: string | null) => (v ? v.length : 0);
const has = (v: string | null) => (v ? 'yes' : 'no');
const plain = (v: string | null) => (v ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  if (!config.nielsen.clientId || !config.nielsen.password) {
    console.error('Nielsen credentials are not set in .env — nothing to compare against.');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  // ── Books: a random sample of the live catalogue, not chosen by who has data.
  const books = (await db.execute(sql`
    SELECT b.isbn13, b.title,
           ab.bio_html  AS bds_bio,
           br.review_html AS bds_review
    FROM books b
    LEFT JOIN book_author_bios ab ON ab.isbn13 = b.isbn13
    LEFT JOIN book_reviews br ON br.isbn13 = b.isbn13 AND br.source = 'bds'
    WHERE b.publishing_status = '04' AND b.isbn13 IS NOT NULL
    ORDER BY random()
    LIMIT ${BOOK_COUNT}
  `)) as unknown as { isbn13: string; title: string; bds_bio: string | null; bds_review: string | null }[];

  console.log(`Comparing ${books.length} books (Nielsen lookups cost ${books.length} records of today's allowance)...`);

  const bookRows: unknown[][] = [];
  const tally = { nielsenReview: 0, bdsReview: 0, both: 0, neither: 0, nielsenOnly: 0, bdsOnly: 0, nielsenMissing: 0 };
  let spent = false;

  for (const [i, book] of books.entries()) {
    const nielsen = spent ? 'budget-spent' : await fetchNielsen(book.isbn13);
    if (nielsen === 'budget-spent') {
      spent = true;
      bookRows.push([book.isbn13, book.title, 'budget spent', '', '', has(book.bds_review), chars(book.bds_review), '', plain(book.bds_review)]);
      continue;
    }

    if (!nielsen.found) tally.nielsenMissing++;
    if (nielsen.review) tally.nielsenReview++;
    if (book.bds_review) tally.bdsReview++;
    if (nielsen.review && book.bds_review) tally.both++;
    else if (nielsen.review) tally.nielsenOnly++;
    else if (book.bds_review) tally.bdsOnly++;
    else tally.neither++;

    bookRows.push([
      book.isbn13,
      book.title,
      nielsen.found ? 'yes' : 'no',
      has(nielsen.review),
      chars(nielsen.review),
      has(book.bds_review),
      chars(book.bds_review),
      plain(nielsen.review),
      plain(book.bds_review),
    ]);

    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${books.length}\r`);
    await sleep(config.nielsen.requestDelayMs);
  }

  writeCsv(
    join(outDir, 'book-reviews-nielsen-vs-bds.csv'),
    ['isbn13', 'title', 'nielsen_has_record', 'nielsen_has_review', 'nielsen_review_chars', 'bds_has_review', 'bds_review_chars', 'nielsen_review', 'bds_review'],
    bookRows,
  );

  // ── Authors: one representative book each, so both suppliers are asked the
  // same question about the same person.
  const authors = (await db.execute(sql`
    SELECT DISTINCT ON (norm)
      btrim(regexp_replace(bc.person_name, '\\s+', ' ', 'g')) AS author,
      lower(btrim(regexp_replace(bc.person_name, '\\s+', ' ', 'g'))) AS norm,
      b.isbn13, b.title, ab.bio_html AS bds_bio
    FROM book_contributors bc
    JOIN books b ON b.id = bc.book_id
    JOIN book_author_bios ab ON ab.isbn13 = b.isbn13
    WHERE bc.role = 'A01'
      AND b.publishing_status = '04'
      AND ab.bio_html IS NOT NULL
      AND (SELECT count(*) FROM book_contributors x WHERE x.book_id = b.id AND x.role = 'A01') = 1
    ORDER BY norm, b.publication_date DESC NULLS LAST
    LIMIT ${AUTHOR_COUNT}
  `)) as unknown as { author: string; isbn13: string; title: string; bds_bio: string }[];

  console.log(`\nComparing ${authors.length} authors...`);

  const authorRows: unknown[][] = [];
  const bioTally = { nielsen: 0, bds: 0, both: 0, neither: 0 };

  for (const [i, author] of authors.entries()) {
    const nielsen = spent ? 'budget-spent' : await fetchNielsen(author.isbn13);
    if (nielsen === 'budget-spent') {
      spent = true;
      authorRows.push([author.author, author.isbn13, author.title, 'budget spent', '', 'yes', chars(author.bds_bio), '', '', plain(author.bds_bio)]);
      continue;
    }

    if (nielsen.bio) bioTally.nielsen++;
    if (author.bds_bio) bioTally.bds++;
    if (nielsen.bio && author.bds_bio) bioTally.both++;
    if (!nielsen.bio && !author.bds_bio) bioTally.neither++;

    authorRows.push([
      author.author,
      author.isbn13,
      author.title,
      has(nielsen.bio),
      chars(nielsen.bio),
      has(author.bds_bio),
      chars(author.bds_bio),
      nielsen.bio && author.bds_bio ? bioSimilarity(nielsen.bio, author.bds_bio, author.author).toFixed(3) : '',
      plain(nielsen.bio),
      plain(author.bds_bio),
    ]);

    if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${authors.length}\r`);
    await sleep(config.nielsen.requestDelayMs);
  }

  writeCsv(
    join(outDir, 'author-bios-nielsen-vs-bds.csv'),
    ['author', 'isbn13', 'title', 'nielsen_has_bio', 'nielsen_bio_chars', 'bds_has_bio', 'bds_bio_chars', 'similarity', 'nielsen_bio', 'bds_bio'],
    authorRows,
  );

  console.log('\nReviews, across', bookRows.length, 'books:');
  console.log('  Nielsen has a record for   ', bookRows.length - tally.nielsenMissing);
  console.log('  Nielsen review             ', tally.nielsenReview);
  console.log('  BDS review                 ', tally.bdsReview);
  console.log('  both / Nielsen only / BDS only / neither:', tally.both, '/', tally.nielsenOnly, '/', tally.bdsOnly, '/', tally.neither);
  console.log('\nBiographies, across', authorRows.length, 'authors:');
  console.log('  Nielsen bio                ', bioTally.nielsen);
  console.log('  BDS bio                    ', bioTally.bds);
  console.log('  both                       ', bioTally.both);
  if (spent) console.log('\n⚠ Nielsen daily allowance ran out partway — those rows say "budget spent".');
  console.log(`\nWrote ${outDir}`);
}

main()
  .then(async () => {
    await redis.quit().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await redis.quit().catch(() => undefined);
    process.exit(1);
  });
