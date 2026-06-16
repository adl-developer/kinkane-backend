import { eq, and, gt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { guestSessions, books, bookContributors, bookGenres, genres, type GuestSession, type Dislikes } from '../db/schema';
import { config } from '../config';
import { inferReaderType, type BookContext } from '../lib/gemini';
import { logger } from '../lib/logger';

export interface CreateGuestSessionInput {
  displayName: string;
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: Dislikes;
  recommendationHash?: string;
}

async function fetchAndInferReaderType(bookIds: number[]): Promise<ReturnType<typeof inferReaderType> extends Promise<infer T> ? T : never> {
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
    logger.error('Failed to fetch book context for reader type inference', { error: (err as Error).message });
    return null;
  }
}

export const guestService = {
  /**
   * Creates a guest session at recommendation time.
   * chosenBookIds starts as null — populated later via saveSelections.
   */
  async create(input: CreateGuestSessionInput): Promise<{ id: string; expiresAt: Date }> {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + config.guestSession.ttlHours * 60 * 60 * 1000,
    );

    const [session] = await db
      .insert(guestSessions)
      .values({
        displayName: input.displayName.trim(),
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
        recommendationHash: input.recommendationHash ?? null,
        expiresAt,
      })
      .returning({ id: guestSessions.id, expiresAt: guestSessions.expiresAt });

    return { id: session.id, expiresAt: session.expiresAt };
  },

  /**
   * Saves the user's 5 chosen books against an existing guest session and
   * infers their reader type via Gemini from those book selections.
   * Returns false if the session doesn't exist or has expired.
   */
  async saveSelections(
    id: string,
    chosenBookIds: number[],
  ): Promise<{ readerType: string | null; books: { id: number; title: string; coverUrl: string | null }[] } | null> {
    const readerType = await fetchAndInferReaderType(chosenBookIds);

    const [updated] = await db
      .update(guestSessions)
      .set({ chosenBookIds, readerType: readerType ?? undefined })
      .where(
        and(
          eq(guestSessions.id, id),
          gt(guestSessions.expiresAt, new Date()),
        ),
      )
      .returning({ id: guestSessions.id });

    if (!updated) return null;

    const selectedBooks = await db
      .select({ id: books.id, title: books.title, coverUrl: books.coverUrl })
      .from(books)
      .where(inArray(books.id, chosenBookIds));

    return { readerType: readerType ?? null, books: selectedBooks };
  },

  /**
   * Returns the session only if it exists and has not expired.
   * Returns null for missing or expired sessions — callers treat both the same way.
   */
  async getById(id: string): Promise<GuestSession | null> {
    const [session] = await db
      .select()
      .from(guestSessions)
      .where(
        and(
          eq(guestSessions.id, id),
          gt(guestSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return session ?? null;
  },
};
