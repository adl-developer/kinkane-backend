import { asc } from 'drizzle-orm';
import { db } from '../db';
import { genres } from '../db/schema/books';
import { redis } from '../lib/redis';
import { genreIdsForSlug, toTopLevelGenres } from '../lib/genre-display';

// Holds the stored rows, full names and all. The top-level list is derived on
// every read, so the shape GET /genres returns can change without this entry
// ever holding the wrong one.
const CACHE_KEY = 'genres:all';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

type GenreRow = { id: number; name: string; slug: string };

async function allRows(): Promise<GenreRow[]> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as GenreRow[];

  const rows = await db
    .select({ id: genres.id, name: genres.name, slug: genres.slug })
    .from(genres)
    .orderBy(asc(genres.name));

  await redis.set(CACHE_KEY, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS);
  return rows;
}

export const genresService = {
  async list(): Promise<GenreRow[]> {
    return toTopLevelGenres(await allRows());
  },

  async idsForSlug(slug: string): Promise<number[]> {
    return genreIdsForSlug(await allRows(), slug);
  },
};
