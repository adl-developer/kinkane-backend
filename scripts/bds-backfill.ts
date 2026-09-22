/**
 * One-off catalogue backfill for BDS author bios and review quotes.
 *
 *   npx tsx scripts/bds-backfill.ts [--limit N]
 *
 * Runs the same sweep as the nightly cron, but with a limit large enough to
 * cover the whole catalogue (default 2,000,000). At 100 ISBNs a call and
 * BDS_REQUEST_DELAY_MS between calls, ~1.1M active books is ~11,000 calls —
 * a few hours. Safe to stop and re-run: every answer is committed as it
 * arrives and the sweep only picks books not yet asked about.
 *
 * Requires BDS_ENRICHMENT_ENABLED=true and credentials, like the cron.
 */
import { config } from '../src/config';
import { redis } from '../src/lib/redis';
import { bdsEnrichmentService } from '../src/services/bds-enrichment.service';

const arg = process.argv.indexOf('--limit');
const limit = arg > -1 ? Number(process.argv[arg + 1]) : 2_000_000;

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
  const totals = await bdsEnrichmentService.runSweep({ limit });
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
