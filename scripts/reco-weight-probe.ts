/**
 * Compares what each weighting actually returns, against a real catalogue. Run
 * once per configuration:
 *
 *   RECO_WEIGHT_BOOKS=42 RECO_WEIGHT_FEELINGS=31 RECO_WEIGHT_GENRES=11 \
 *   RECO_WEIGHT_DISLIKES=16 RECO_WEIGHT_TAGS=0 npx tsx scripts/reco-weight-probe.ts "Mood First"
 *
 * Environment set on the command line wins over .env (dotenv does not
 * override), so each run is a real boot of the real config.
 *
 * The liked books are looked up by title and author (see probe-support.ts), or
 * pass PROBE_LIKED_IDS=1,2,3 to measure a specific reader.
 */
import { db } from '../src/db';
import { sql, inArray } from 'drizzle-orm';
import { books } from '../src/db/schema';
import { generatePreferenceVector } from '../src/services/recommendations.service';
import { config } from '../src/config';
import { likedBooksForProbe } from './probe-support';

const LABEL = process.argv[2] ?? 'unlabelled';

const INPUT = {
  feelings: ['comforted', 'hopeful', 'uplifted'],
  genres: ['romance', 'literary fiction'],
  dislikes: { contentSensitivity: ['graphic violence'] } as never,
};

async function main() {
  const LIKED_IDS = await likedBooksForProbe();
  // Goes through drizzle's select, exactly as fetchLikedBooks does — a raw
  // db.execute skips the pgvector customType and hands back the vector as a
  // string, which the lane correctly refuses to use.
  const rows = await db
    .select({ id: books.id, title: books.title, embedding: books.embedding })
    .from(books)
    .where(inArray(books.id, LIKED_IDS));
  const likedBooks = rows.map((r) => ({ id: r.id, title: r.title, authors: [], embedding: r.embedding }));

  const t0 = Date.now();
  const vector = await generatePreferenceVector(INPUT, likedBooks);
  const embedMs = Date.now() - t0;
  const literal = `[${vector.join(',')}]`;

  // How far the query landed from the reader's own books. This is the headline
  // number: a fingerprint built from those books should sit near them, and one
  // built from their titles should not.
  const toLiked = (await db.execute(sql`
    select id, title, (embedding <=> ${literal}::vector)::float8 as d
    from books where id in ${sql.raw('(' + LIKED_IDS.join(',') + ')')} order by d`)) as unknown as {
    id: number; title: string; d: number;
  }[];

  const top = (await db.execute(sql`
    select id, title, (embedding <=> ${literal}::vector)::float8 as d
    from books
    where embedding is not null and is_removed = false
      and id not in ${sql.raw('(' + LIKED_IDS.join(',') + ')')}
    order by embedding <=> ${literal}::vector
    limit 20`)) as unknown as { id: number; title: string; d: number }[];

  const strict = (await db.execute(sql`
    select count(*)::int as n from (
      select 1 from books where embedding is not null and is_removed = false
        and (embedding <=> ${literal}::vector) < ${config.recommendations.similarityMax}
      limit 5000) s`)) as unknown as { n: number }[];

  console.log(JSON.stringify({
    label: LABEL,
    weights: config.recommendations.weights,
    booksFromEmbeddings: config.recommendations.booksFromEmbeddings,
    embedMs,
    distanceToOwnBooks: {
      mean: +(toLiked.reduce((a, r) => a + r.d, 0) / toLiked.length).toFixed(4),
      nearest: +toLiked[0].d.toFixed(4),
      furthest: +toLiked[toLiked.length - 1].d.toFixed(4),
    },
    strictTierCount: strict[0].n,
    topDistance: +top[0].d.toFixed(4),
    top20: top.map((r) => ({ id: r.id, t: r.title.slice(0, 58), d: +r.d.toFixed(4) })),
  }));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
