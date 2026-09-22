/**
 * Phase 0 for BDS: measure what they actually hold for our catalogue before
 * we switch anything on.
 *
 *   npx tsx scripts/bds-probe.ts [path/to/isbns.csv]
 *
 * Needs BDS_USERNAME and BDS_PASSWORD in .env (BDS_ENRICHMENT_ENABLED does not
 * matter — this script never writes to the database). Defaults to the
 * 500-ISBN catalogue sample at the repo root.
 *
 * It answers four questions, in order, and stops early if an answer makes the
 * rest meaningless:
 *
 *   1. Does login work, and what fields does a full record actually carry?
 *      (Checks the field names lib/bds.ts asks for, and shows what
 *      author_bio and biographical_note each contain.)
 *   2. Does the 100-ISBNs-per-call OR query return everything it should?
 *      (Compares one batched call against the same ISBNs asked one at a time.)
 *   3. What share of the sample gets a bio, a review, prizes, related editions?
 *   4. How many of those reviews are for books Nielsen has no review for?
 *
 * Output goes to probe-output/bds-<timestamp>/ (git-ignored — it holds
 * licensed BDS text): raw responses, a per-ISBN CSV and summary.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { inArray } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db';
import { bookReviews } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import { bdsGet, fetchByIsbns, isbnQueryParams, parseRecords, type BdsRecord } from '../src/lib/bds';

const KNOWN_ISBN = '9780241635537'; // the example Barry Smith (BDS) gave us
const SYNTAX_CHECK_SIZE = 10;

const csvPath = resolve(process.argv[2] ?? join(__dirname, '../../isbn-sample-500.csv'));
const outDir = join(__dirname, '../probe-output', `bds-${new Date().toISOString().replace(/[:.]/g, '-')}`);

function readIsbns(path: string): string[] {
  return [
    ...new Set(
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.split(',')[0].trim())
        .filter((l) => /^97[89]\d{10}$/.test(l)),
    ),
  ];
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${n}/${d} (${((100 * n) / d).toFixed(1)}%)`;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Element names present in a raw response, fv_ prefix dropped. */
function fieldNames(xml: string): string[] {
  // CDATA first, or the <p>/<strong> inside bios get listed as fields.
  const bare = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const envelope = new Set(['resultscollection', 'resultsetinformation', 'resultfields', 'record', 'records']);
  return [...new Set([...bare.matchAll(/<(?:fv_)?([a-z0-9_]+)[\s>/]/gi)].map((m) => m[1].toLowerCase()))]
    .filter((n) => !envelope.has(n))
    .sort();
}

async function main() {
  if (!config.bds.username || !config.bds.password) {
    console.error('BDS_USERNAME / BDS_PASSWORD are not set in .env — nothing to probe with.');
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  const isbns = readIsbns(csvPath);
  console.log(`Sample: ${isbns.length} ISBNs from ${csvPath}`);
  console.log(`Output: ${outDir}\n`);

  // ── 1. Login + a full, unfiltered record ──────────────────────────────────
  console.log('1. Login and full-record check');
  const full = await bdsGet({ SF1: 'identifier', ST1: KNOWN_ISBN, VIEW: 'xml' });
  writeFileSync(join(outDir, 'full-record.xml'), full);
  const names = fieldNames(full);
  const [fullRecord] = parseRecords(full);
  console.log(`   login OK; ${KNOWN_ISBN}: ${fullRecord ? 'found' : 'NOT found'}`);
  console.log(`   fields present: ${names.join(', ')}`);
  for (const f of ['author_bio', 'biographical_note', 'review', 'prizes', 'related_editions', 'index_updated', 'barcode']) {
    if (!names.includes(f)) console.log(`   ⚠ field "${f}" not in the response — check its name in lib/bds.ts`);
  }
  const filtered = await bdsGet(isbnQueryParams([KNOWN_ISBN]));
  writeFileSync(join(outDir, 'filtered-record.xml'), filtered);
  if (parseRecords(filtered).length === 0 && fullRecord) {
    console.log('   ⚠ the FIELDS-filtered request returned no record — FIELDS names or VIEW need fixing');
  }

  // ── 2. Batch syntax ───────────────────────────────────────────────────────
  console.log(`\n2. Batch query check (${SYNTAX_CHECK_SIZE} ISBNs, batched vs one at a time)`);
  const probeSet = isbns.slice(0, SYNTAX_CHECK_SIZE);
  const batched = await fetchByIsbns(probeSet);
  let individuallyFound = 0;
  let batchedFound = 0;
  for (const isbn of probeSet) {
    const single = await fetchByIsbns([isbn]);
    if (single.get(isbn)) individuallyFound++;
    if (batched.get(isbn)) batchedFound++;
    await new Promise((r) => setTimeout(r, config.bds.requestDelayMs));
  }
  console.log(`   one at a time: ${individuallyFound} found; batched: ${batchedFound} found`);
  const batchWorks = batchedFound === individuallyFound;
  if (!batchWorks) {
    console.log('   ⚠ batched query loses records — fix isbnQueryParams() before trusting step 3');
  }

  // ── 3. Coverage ───────────────────────────────────────────────────────────
  console.log('\n3. Coverage across the sample');
  const results = new Map<string, BdsRecord | null>();
  for (let i = 0; i < isbns.length; i += config.bds.batchSize) {
    const batch = isbns.slice(i, i + config.bds.batchSize);
    const page = await fetchByIsbns(batch);
    for (const [k, v] of page) results.set(k, v);
    process.stdout.write(`   ${Math.min(i + batch.length, isbns.length)}/${isbns.length}\r`);
    await new Promise((r) => setTimeout(r, config.bds.requestDelayMs));
  }

  const records = [...results.values()];
  const found = records.filter(Boolean) as BdsRecord[];
  const withAuthorBio = found.filter((r) => r.authorBio);
  const withNote = found.filter((r) => r.biographicalNotes.length > 0);
  const withAnyBio = found.filter((r) => r.authorBio || r.biographicalNotes.length > 0);
  const withReview = found.filter((r) => r.review);
  const withPrizes = found.filter((r) => r.prizes);
  const withEditions = found.filter((r) => r.relatedEditions.length > 0);
  const bothBioFields = found.filter((r) => r.authorBio && r.biographicalNotes.length > 0);
  const sameBioText = bothBioFields.filter((r) =>
    r.biographicalNotes.some((n) => n.replace(/<[^>]+>/g, '').trim() === r.authorBio!.replace(/<[^>]+>/g, '').trim()),
  );

  // ── 4. Overlap with Nielsen ───────────────────────────────────────────────
  const nielsenRows = await db
    .select({ isbn13: bookReviews.isbn13, reviewHtml: bookReviews.reviewHtml })
    .from(bookReviews)
    .where(inArray(bookReviews.isbn13, isbns));
  const nielsenHas = new Set(nielsenRows.filter((r) => r.reviewHtml).map((r) => r.isbn13));
  const nielsenChecked = new Set(nielsenRows.map((r) => r.isbn13));
  const bdsReviewNielsenNone = withReview.filter((r) => nielsenChecked.has(r.isbn13) && !nielsenHas.has(r.isbn13));
  const bdsReviewNielsenUnchecked = withReview.filter((r) => !nielsenChecked.has(r.isbn13));

  const summary = {
    sampleSize: isbns.length,
    batchQueryVerified: batchWorks,
    found: found.length,
    authorBio: withAuthorBio.length,
    biographicalNote: withNote.length,
    anyBio: withAnyBio.length,
    bothBioFields: bothBioFields.length,
    bothBioFieldsIdentical: sameBioText.length,
    review: withReview.length,
    prizes: withPrizes.length,
    relatedEditions: withEditions.length,
    nielsenChecked: nielsenChecked.size,
    nielsenHasReview: nielsenHas.size,
    bdsReviewWhereNielsenHasNone: bdsReviewNielsenNone.length,
    bdsReviewWhereNielsenNotYetChecked: bdsReviewNielsenUnchecked.length,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const header = 'isbn13,found,author_bio_chars,biographical_notes,review_chars,prizes,related_editions,index_updated,nielsen';
  const rows = isbns.map((isbn) => {
    const r = results.get(isbn);
    const nielsen = nielsenHas.has(isbn) ? 'review' : nielsenChecked.has(isbn) ? 'none' : 'unchecked';
    return [
      isbn,
      r ? 'Y' : 'N',
      r?.authorBio?.length ?? 0,
      r?.biographicalNotes.length ?? 0,
      r?.review?.length ?? 0,
      r?.prizes ?? '',
      r?.relatedEditions.join('|') ?? '',
      r?.indexUpdated ?? '',
      nielsen,
    ]
      .map(csvCell)
      .join(',');
  });
  writeFileSync(join(outDir, 'per-isbn.csv'), [header, ...rows].join('\n'));

  const n = isbns.length;
  console.log(`   BDS has the book        ${pct(found.length, n)}`);
  console.log(`   author_bio              ${pct(withAuthorBio.length, n)}`);
  console.log(`   biographical_note       ${pct(withNote.length, n)}`);
  console.log(`   any bio                 ${pct(withAnyBio.length, n)}`);
  console.log(`     both fields, same text ${pct(sameBioText.length, bothBioFields.length)}`);
  console.log(`   review                  ${pct(withReview.length, n)}`);
  console.log(`   prizes                  ${pct(withPrizes.length, n)}`);
  console.log(`   related editions        ${pct(withEditions.length, n)}`);
  console.log('\n4. Against Nielsen (local book_reviews)');
  console.log(`   Nielsen checked ${nielsenChecked.size}, has a review for ${nielsenHas.size}`);
  console.log(`   BDS review where Nielsen has none:        ${bdsReviewNielsenNone.length}`);
  console.log(`   BDS review where Nielsen not yet checked: ${bdsReviewNielsenUnchecked.length}`);
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
