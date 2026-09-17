/**
 * End-to-end check that the two tiers still both do something.
 *
 * Computes the same preference vector the API will, counts how much of the
 * catalogue falls in each tier, then calls the live endpoint and measures the
 * distance of every book it returned. A result beyond SIMILARITY_MAX can only
 * have come from the backfill tier, which is the thing the old 0.5 cutoff made
 * unreachable.
 */
import { db } from '../src/db';
import { sql, inArray } from 'drizzle-orm';
import { books } from '../src/db/schema';
import { generatePreferenceVector } from '../src/services/recommendations.service';
import { config } from '../src/config';
import { likedBooksForProbe, parseIdOverride, sampleBooks } from './probe-support';

type Reader = { label: string; bookIds: number[]; feelings: string[]; genres: string[] };

// Points at a local dev server by default. PROBE_API_URL can aim it elsewhere,
// but every call creates a guest session and spends Gemini calls generating
// explanations, so do not aim it at production casually.
const API_URL = process.env.PROBE_API_URL ?? `http://localhost:${config.port}`;

async function readers(): Promise<Reader[]> {
  return [
    {
      label: 'coherent (literary/grief)',
      bookIds: await likedBooksForProbe(),
      feelings: ['comforted', 'hopeful', 'moved'],
      genres: ['literary fiction', 'historical fiction', 'classics'],
    },
    {
      // Five books drawn at random from the catalogue — about as incoherent as a
      // taste can be, and meaningful on any database.
      label: 'incoherent (random sample)',
      bookIds: parseIdOverride('PROBE_INCOHERENT_IDS') ?? (await sampleBooks(5, 'reco-tier-probe')),
      feelings: ['curious', 'challenged', 'surprised'],
      genres: ['poetry', 'sport', 'travel'],
    },
  ];
}

async function main() {
  const { similarityMax, backfillMax, targetResults } = config.recommendations;

  for (const r of await readers()) {
    const liked = await db
      .select({ id: books.id, title: books.title, embedding: books.embedding })
      .from(books)
      .where(inArray(books.id, r.bookIds));

    const v = await generatePreferenceVector(
      { feelings: r.feelings, genres: r.genres, dislikes: { contentSensitivity: ['graphic violence'] } as never },
      liked.map((b) => ({ id: b.id, title: b.title, authors: [], embedding: b.embedding })),
    );
    const lit = `[${v.join(',')}]`;

    const [counts] = (await db.execute(sql`
      select
        count(*) filter (where (embedding <=> ${lit}::vector) < ${similarityMax})::int as strict,
        count(*) filter (where (embedding <=> ${lit}::vector) >= ${similarityMax}
                           and (embedding <=> ${lit}::vector) < ${backfillMax})::int as backfill_band
      from books where embedding is not null and is_removed = false`)) as unknown as Record<string, number>[];

    const res = await fetch(`${API_URL}/api/v1/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Probe', ...r, dislikes: { contentSensitivity: ['graphic violence'] } }),
    });
    const body = (await res.json()) as { recommendations?: { bookId: number; rank: number }[]; error?: unknown };
    const recs = body.recommendations ?? [];

    let served = { strict: 0, backfill: 0, beyond: 0, maxD: 0 };
    if (recs.length) {
      const ids = recs.map((x) => x.bookId);
      const rows = (await db.execute(sql`
        select id, (embedding <=> ${lit}::vector)::float8 d from books
        where id in ${sql.raw('(' + ids.join(',') + ')')}`)) as unknown as { id: number; d: number }[];
      for (const row of rows) {
        served.maxD = Math.max(served.maxD, row.d);
        if (row.d < similarityMax) served.strict++;
        else if (row.d < backfillMax) served.backfill++;
        else served.beyond++;
      }
    }

    console.log(
      `${r.label}\n  catalogue: strict=${counts.strict} backfillBand=${counts.backfill_band}` +
        `\n  http: ${res.status}, returned=${recs.length}/${targetResults}` +
        `\n  served: strict=${served.strict} fromBackfill=${served.backfill} beyondBackfill=${served.beyond} maxDistance=${served.maxD.toFixed(3)}` +
        (body.error ? `\n  error: ${JSON.stringify(body.error).slice(0, 160)}` : ''),
    );
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
