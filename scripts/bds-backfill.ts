/**
 * One-off catalogue backfill for BDS author bios and review quotes.
 *
 *   npx tsx scripts/bds-backfill.ts [--limit N] [--concurrency N]
 *
 * Runs the same sweep as the nightly cron, but with a limit large enough to
 * cover the whole catalogue (default 2,000,000). ~1.1M active books is ~11,000
 * calls: about 8 hours serially, or 2.5 with --concurrency 4. Measured at 38
 * books/sec serial on 2026-09-25.
 *
 * Safe to stop and re-run: every answer is committed as it arrives, and the
 * sweep walks books by id, asking only about those with no answer yet.
 *
 * Requires BDS_ENRICHMENT_ENABLED=true and credentials, like the cron.
 */
import { config } from '../src/config';
import { redis } from '../src/lib/redis';
import { bdsEnrichmentService } from '../src/services/bds-enrichment.service';

function numberArg(flag: string, fallback: number): number {
  const at = process.argv.indexOf(flag);
  return at > -1 ? Number(process.argv[at + 1]) : fallback;
}

const limit = numberArg('--limit', 2_000_000);
const concurrency = numberArg('--concurrency', config.bds.concurrency);

async function main() {
  if (!config.bds.enabled) {
    console.error('BDS enrichment is not enabled (BDS_ENRICHMENT_ENABLED=true plus BDS_USERNAME/BDS_PASSWORD).');
    process.exit(2);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error('--limit must be a positive number');
    process.exit(2);
  }
  const started = Date.now();
  console.log(`Backfilling up to ${limit.toLocaleString()} books, ${concurrency} request(s) at a time.`);
  const totals = await bdsEnrichmentService.runSweep({ limit, concurrency });
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
