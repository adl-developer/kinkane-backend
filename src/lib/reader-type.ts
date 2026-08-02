import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors, bookGenres, genres, type ReaderType } from '../db/schema';
import { inferReaderType, type BookContext } from './gemini';
import { logger } from './logger';

/**
 * Infers a reader type from a set of chosen book IDs: loads each book's title,
 * primary authors and genres, then hands that context to Gemini.
 *
 * Shared by both quiz paths — guest onboarding, which stores the result on the
 * user row at signup, and the logged-in retake, which records it in the
 * preference history without touching the user row.
 *
 * Never throws. Reader type is a nice-to-have label, not something worth
 * failing a signup or a preference save over — a null result just means the
 * caller keeps whatever it already had.
 */
export async function fetchAndInferReaderType(bookIds: number[]): Promise<ReaderType | null> {
  if (bookIds.length === 0) return null;

  try {
    const [bookRows, contributors, genreRows] = await Promise.all([
      db.select({ id: books.id, title: books.title }).from(books).where(inArray(books.id, bookIds)),
      db
        .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
        .from(bookContributors)
        .where(and(inArray(bookContributors.bookId, bookIds), eq(bookContributors.role, 'A01')))
        .orderBy(bookContributors.sequenceNumber),
      db
        .select({ bookId: bookGenres.bookId, name: genres.name })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, bookIds)),
    ]);

    const authorMap = new Map<number, string[]>();
    for (const c of contributors) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    const genreMap = new Map<number, string[]>();
    for (const g of genreRows) {
      if (!genreMap.has(g.bookId)) genreMap.set(g.bookId, []);
      genreMap.get(g.bookId)!.push(g.name);
    }

    const bookContexts: BookContext[] = bookRows.map((b) => ({
      bookId: b.id,
      title: b.title,
      authors: authorMap.get(b.id) ?? [],
      genres: genreMap.get(b.id) ?? [],
    }));

    return inferReaderType(bookContexts);
  } catch (err) {
    logger.error('Failed to fetch book context for reader type inference', {
      error: (err as Error).message,
    });
    return null;
  }
}
