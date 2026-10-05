/**
 * Recreates the user_preferences row (and its embedding) for readers whose
 * quiz answers never landed there.
 *
 *   npx tsx scripts/backfill-missing-preferences.ts --dry-run   # list, write nothing
 *   npx tsx scripts/backfill-missing-preferences.ts             # write
 *
 * Until 2026-10-05, PATCH /recommendations/refresh saved preferences with a
 * bare UPDATE. A reader who registered without doing the guest quiz has no
 * row, so the UPDATE matched nothing and the endpoint still returned 200 —
 * leaving them with an empty personalized feed and a 404 on GET /preferences.
 *
 * The preference history write in that same path is an INSERT, so it did
 * land: each affected reader's latest history row holds exactly the answers
 * the lost save should have written. That row is the source here.
 *
 * Only readers with no preferences row are touched, and the insert does
 * nothing on conflict, so re-running is safe and never overwrites a row a
 * reader has saved since. The embedding is built by the same
 * regeneratePreferenceEmbedding the refresh path uses, which also busts the
 * reader's personalized feed cache.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { userPreferences } from '../src/db/schema';
import type { Dislikes } from '../src/db/schema/onboarding';
import { regeneratePreferenceEmbedding } from '../src/services/recommendations.service';
import { disconnectRedis } from '../src/lib/redis';

const dryRun = process.argv.includes('--dry-run');

interface Candidate {
  user_id: number;
  email: string;
  recorded_at: string;
  feelings: string[];
  book_ids: number[];
  genres: string[];
  dislikes: Dislikes;
}

async function main(): Promise<void> {
  const candidates = (await db.execute(sql`
    SELECT DISTINCT ON (h.user_id)
      h.user_id, u.email, h.recorded_at, h.feelings, h.book_ids, h.genres, h.dislikes
    FROM user_preference_history h
    JOIN users u ON u.id = h.user_id
    WHERE NOT EXISTS (SELECT 1 FROM user_preferences p WHERE p.user_id = h.user_id)
    ORDER BY h.user_id, h.recorded_at DESC
  `)) as unknown as Candidate[];

  console.log(`${candidates.length} reader(s) with quiz history but no preferences row`);

  let failed = 0;
  for (const c of candidates) {
    const input = { feelings: c.feelings, bookIds: c.book_ids, genres: c.genres, dislikes: c.dislikes };
    console.log(`  user ${c.user_id} <${c.email}> from history at ${c.recorded_at}`);
    if (dryRun) continue;

    try {
      await db
        .insert(userPreferences)
        .values({ userId: c.user_id, ...input })
        .onConflictDoNothing({ target: userPreferences.userId });
      await regeneratePreferenceEmbedding(c.user_id, input);
      console.log('    restored, embedding written');
    } catch (err) {
      failed++;
      console.error(`    FAILED: ${(err as Error).message}`);
    }
  }

  if (dryRun) console.log('Dry run: nothing written.');
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectRedis().catch(() => undefined);
    process.exit();
  });
