/**
 * Picks the candidate cutoffs from measurement rather than intuition.
 *
 * Each synthetic reader is a seed book plus its four nearest neighbours — a
 * coherent taste by construction — with plausible quiz answers on top. For each
 * one we ask the operationally useful question: at what distance does the Nth
 * nearest book sit? RECO_SIMILARITY_MAX wants to sit around the pool size, so a
 * typical reader fills the pool with strict matches while an unusual reader
 * falls short and the backfill tier does its job.
 */
import { db } from '../src/db';
import { sql, inArray } from 'drizzle-orm';
import { books } from '../src/db/schema';
import { generatePreferenceVector } from '../src/services/recommendations.service';
import { config } from '../src/config';
import { nearestBooks, parseIdOverride, sampleBooks } from './probe-support';

// Seed books are a deterministic sample of this catalogue, so the probe means
// the same thing on any database — the point of it is to be re-run against
// production, whose ids share nothing with a local copy. Pass
// PROBE_SEED_IDS=1,2,3 to measure particular readers instead.
const SEED_COUNT = 8;
const SEED_SALT = 'reco-cutoff-probe';

const QUIZZES = [
  { feelings: ['comforted', 'hopeful'], genres: ['literary fiction'] },
  { feelings: ['thrilled', 'gripped'], genres: ['crime', 'mystery'] },
  { feelings: ['moved'], genres: ['historical fiction', 'classics'] },
  { feelings: ['entertained', 'uplifted'], genres: ['romance'] },
];

function quantile(sorted: number[], q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function main() {
  const SEEDS = parseIdOverride('PROBE_SEED_IDS') ?? (await sampleBooks(SEED_COUNT, SEED_SALT));
  const rows: Record<string, number>[] = [];

  for (let i = 0; i < SEEDS.length; i++) {
    const seed = SEEDS[i];
    const near = await nearestBooks(seed, 5);
    const liked = await db
      .select({ id: books.id, title: books.title, embedding: books.embedding })
      .from(books)
      .where(inArray(books.id, near));

    const quiz = QUIZZES[i % QUIZZES.length];
    const v = await generatePreferenceVector(
      { ...quiz, dislikes: { content: ['graphic violence'] } as never },
      liked.map((b) => ({ id: b.id, title: b.title, authors: [], embedding: b.embedding })),
    );
    const lit = `[${v.join(',')}]`;

    // Distance of the Nth nearest book — the number the cutoffs need to bracket.
    const [d] = (await db.execute(sql`
      with ranked as (
        select (embedding <=> ${lit}::vector)::float8 d,
               row_number() over (order by embedding <=> ${lit}::vector) rn
        from books where embedding is not null and is_removed = false)
      select
        max(d) filter (where rn = 100)  as d100,
        max(d) filter (where rn = 300)  as d300,
        max(d) filter (where rn = 1000) as d1000,
        max(d) filter (where rn = 5000) as d5000
      from ranked`)) as unknown as Record<string, number>[];

    rows.push({ seed, ...d });
    console.log(`seed ${String(seed).padEnd(6)} d@100=${d.d100.toFixed(3)} d@300=${d.d300.toFixed(3)} d@1000=${d.d1000.toFixed(3)} d@5000=${d.d5000.toFixed(3)}`);
  }

  if (rows.length === 0) throw new Error('No seed produced a measurement.');
  for (const k of ['d100', 'd300', 'd1000', 'd5000']) {
    const vals = rows.map((r) => r[k]).sort((a, b) => a - b);
    console.log(`${k}: min=${vals[0].toFixed(3)} median=${quantile(vals, 0.5).toFixed(3)} max=${vals[vals.length - 1].toFixed(3)}`);
  }
  console.log(`current: similarityMax=${config.recommendations.similarityMax} backfillMax=${config.recommendations.backfillMax} fetchPool=${config.recommendations.fetchPool}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
