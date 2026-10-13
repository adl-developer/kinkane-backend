/**
 * One-off catalogue backfill for reviews extracted from publisher long
 * descriptions.
 *
 *   npx tsx scripts/publisher-reviews-backfill.ts [--limit N] [--after-id N] [--no-llm] [--retry-fallback] [--force]
 *
 * Walks every book by id and stores a 'publisher' row in book_reviews for each
 * one whose long description has reviews in it. Books without reviews get no
 * row. Each page of 1,000 books is committed before the next is read. A re-run
 * skips books whose reviews were read from the same description, and
 * re-checks books that have none.
 *
 *   --after-id N      Resume a stopped run: start after book id N (the
 *                     "lastId" it printed).
 *   --no-llm          Rules only. Books the rules hand over keep whatever the
 *                     rules found, marked 'rules_fallback'; ones where they
 *                     found nothing get no row and are re-checked next run.
 *   --retry-fallback  Also re-run books stored as 'rules_fallback', so the
 *                     LLM gets the ones it missed.
 *   --force           Re-extract every book, not just changed ones. Use after
 *                     changing the extraction rules in lib/publisher-reviews.ts.
 *
 * Production sizing (13 Oct 2026 read-only dry run): ~1.65M descriptions,
 * about 22,000 (1.3%) of them go to the LLM, and about 96,000 books end up
 * with a row.
 */
import { publisherReviewsService } from '../src/services/publisher-reviews.service';
import { redis } from '../src/lib/redis';

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg > -1 ? Number(args[limitArg + 1]) : undefined;
const afterArg = args.indexOf('--after-id');
const afterId = afterArg > -1 ? Number(args[afterArg + 1]) : undefined;
const useLlm = args.includes('--no-llm') ? false : undefined;
const retryFallback = args.includes('--retry-fallback');
const force = args.includes('--force');

async function main() {
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error('--limit must be a positive number');
    process.exit(2);
  }
  if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) {
    console.error('--after-id must be a book id');
    process.exit(2);
  }
  const started = Date.now();
  let lastLog = 0;
  const totals = await publisherReviewsService.runBackfill({
    limit,
    useLlm,
    retryFallback,
    force,
    afterId,
    onPage: (s) => {
      if (Date.now() - lastLog < 15_000) return;
      lastLog = Date.now();
      console.log(`${((Date.now() - started) / 60_000).toFixed(1)} min`, s);
    },
  });
  console.log({ ...totals, minutes: ((Date.now() - started) / 60_000).toFixed(1) });
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
