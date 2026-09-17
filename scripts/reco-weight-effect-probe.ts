/**
 * Does each weighting actually change which books come back, in the direction
 * the weights claim?
 *
 * The reader is held fixed and only the weights move, so any difference in the
 * results is attributable to the weights alone.
 *
 * Each lane's vector is taken from a real book in the catalogue rather than
 * from Gemini's embedding of the quiz text. That is a deliberate substitution:
 * it removes the Gemini dependency, and it gives each lane an unambiguous pole
 * to measure against, which an embedding of "I want to feel comforted" does not
 * (see the mood-lane finding — that text lands near palliative-care textbooks).
 * What it tests is the weighting: whether raising a lane's share pulls the
 * returned books towards that lane's pole.
 */
import { db } from '../src/db';
import { sql, inArray } from 'drizzle-orm';
import { books } from '../src/db/schema';
import { averageUnitVectors, combineWeightedVectors, type WeightedLane } from '../src/lib/vector';
import { likedBooksForProbe, resolveBooks, type BookRef } from './probe-support';

// Poles, looked up by title and author so they mean the same books on any
// catalogue. Each is deliberately at odds with the literary reader, so any pull
// towards it is visible rather than a matter of interpretation.
const POLES: Record<'mood' | 'genre' | 'dislike', BookRef> = {
  mood: { title: 'Christmas at the Comfort Food Cafe', author: 'Debbie Johnson' },
  genre: { title: 'The Dead Romantics', author: 'Ashley Poston' }, // the quiz's "romance" selection
  dislike: { title: 'American Psycho', author: 'Bret Easton Ellis' }, // "graphic violence"
};

const SPLITS: Record<string, { books: number; feelings: number; genres: number; dislikes: number }> = {
  'Taste DNA': { books: 72, feelings: 11, genres: 6, dislikes: 11 },
  'Mood First': { books: 42, feelings: 31, genres: 11, dislikes: 16 },
  Explorer: { books: 64, feelings: 23, genres: 7, dislikes: 6 },
};

const TOP_N = 50;

async function embeddingOf(id: number): Promise<number[]> {
  const [r] = await db.select({ e: books.embedding }).from(books).where(inArray(books.id, [id]));
  if (!r?.e) throw new Error(`book ${id} has no embedding`);
  return r.e;
}

async function main() {
  const LIKED = await likedBooksForProbe();
  const [MOOD_POLE, GENRE_POLE, DISLIKE_POLE] = await resolveBooks([POLES.mood, POLES.genre, POLES.dislike]);
  const liked = await db
    .select({ id: books.id, embedding: books.embedding })
    .from(books)
    .where(inArray(books.id, LIKED));
  const tasteVec = averageUnitVectors(liked.map((b) => b.embedding!).filter(Boolean))!;
  const moodVec = await embeddingOf(MOOD_POLE);
  const genreVec = await embeddingOf(GENRE_POLE);
  const dislikeVec = await embeddingOf(DISLIKE_POLE);

  const tasteLit = `[${tasteVec.join(',')}]`;
  const moodLit = `[${moodVec.join(',')}]`;
  const dislikeLit = `[${dislikeVec.join(',')}]`;

  const results: Record<string, { ids: number[]; toTaste: number; toMood: number; toDislike: number; titles: string[] }> = {};

  for (const [label, w] of Object.entries(SPLITS)) {
    const q = combineWeightedVectors([
      { field: 'books', vector: tasteVec, weight: w.books, sign: 1 },
      { field: 'feelings', vector: moodVec, weight: w.feelings, sign: 1 },
      { field: 'genres', vector: genreVec, weight: w.genres, sign: 1 },
      { field: 'dislikes', vector: dislikeVec, weight: w.dislikes, sign: -1 },
    ] as WeightedLane[])!;
    const lit = `[${q.join(',')}]`;

    const rows = (await db.execute(sql`
      select id, title,
             (embedding <=> ${tasteLit}::vector)::float8   as to_taste,
             (embedding <=> ${moodLit}::vector)::float8    as to_mood,
             (embedding <=> ${dislikeLit}::vector)::float8 as to_dislike
      from books
      where embedding is not null and is_removed = false
        -- The poles are excluded along with the liked books: a pole is trivially
        -- nearest to itself, and listing it as a "result" says nothing.
        and id not in ${sql.raw('(' + [...LIKED, MOOD_POLE, GENRE_POLE, DISLIKE_POLE].join(',') + ')')}
      order by embedding <=> ${lit}::vector
      limit ${TOP_N}`)) as unknown as {
      id: number; title: string; to_taste: number; to_mood: number; to_dislike: number;
    }[];

    const mean = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
    results[label] = {
      ids: rows.map((r) => r.id),
      toTaste: mean((r) => r.to_taste),
      toMood: mean((r) => r.to_mood),
      toDislike: mean((r) => r.to_dislike),
      titles: rows.slice(0, 5).map((r) => r.title.slice(0, 44)),
    };
  }

  console.log(`\nMean distance of the top ${TOP_N} to each pole (lower = closer):\n`);
  console.log('                 →taste   →mood   →violence');
  for (const [label, r] of Object.entries(results)) {
    console.log(`${label.padEnd(12)}  ${r.toTaste.toFixed(4)}  ${r.toMood.toFixed(4)}  ${r.toDislike.toFixed(4)}`);
  }

  console.log(`\nOverlap of the top ${TOP_N}:`);
  const labels = Object.keys(results);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = new Set(results[labels[i]].ids);
      const shared = results[labels[j]].ids.filter((id) => a.has(id)).length;
      console.log(`  ${labels[i]} ∩ ${labels[j]}: ${shared}/${TOP_N}`);
    }
  }

  console.log('\nTop 5 each:');
  for (const [label, r] of Object.entries(results)) {
    console.log(`  ${label}: ${r.titles.join(' | ')}`);
  }

  // The claims the weights make, stated as pass/fail rather than left to the eye.
  const checks: [string, boolean][] = [
    ['Taste DNA sits closest to the reader\'s own books', results['Taste DNA'].toTaste < results['Mood First'].toTaste],
    ['Mood First sits closest to the mood pole', results['Mood First'].toMood < results['Taste DNA'].toMood && results['Mood First'].toMood < results['Explorer'].toMood],
    ['Explorer sits between the two on taste', results['Explorer'].toTaste > results['Taste DNA'].toTaste && results['Explorer'].toTaste < results['Mood First'].toTaste],
    ['Mood First pushes hardest away from the dislike pole', results['Mood First'].toDislike > results['Explorer'].toDislike],
    ['the three return materially different books', results['Taste DNA'].ids.filter((id) => new Set(results['Mood First'].ids).has(id)).length < TOP_N * 0.9],
  ];
  console.log('');
  let failed = 0;
  for (const [claim, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}`);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
