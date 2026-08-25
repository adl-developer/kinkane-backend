import { eq, and, gt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { guestSessions, books, type GuestSession, type Dislikes } from '../db/schema';
import { config } from '../config';
import { fetchAndInferReaderType } from '../lib/reader-type';

export interface CreateGuestSessionInput {
  displayName: string;
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: Dislikes;
  recommendationHash?: string;
}

export const guestService = {
  /**
   * Parks a referral code on an existing guest session so it survives until
   * there is a user row to attribute it to.
   *
   * A separate call rather than a field on create() because guest sessions are
   * created several layers down inside the recommendations flow, and a referral
   * code has nothing to do with generating recommendations — threading it
   * through every one of those call sites would put competition plumbing in the
   * middle of an unrelated feature. The client calls this once it holds both a
   * session and a code.
   *
   * Returns false when the session doesn't exist or has expired.
   */
  async attachReferralCode(sessionId: string, referralCode: string): Promise<boolean> {
    const updated = await db
      .update(guestSessions)
      .set({ referralCode: referralCode.toUpperCase() })
      .where(and(eq(guestSessions.id, sessionId), gt(guestSessions.expiresAt, new Date())))
      .returning({ id: guestSessions.id });

    return updated.length > 0;
  },

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
   *
   * Books swiped away on the same screen are parked on the session too. They
   * do nothing for this guest — there's no user row to hang a rejection
   * history off yet, and this quiz's results are already generated — but
   * migrateGuestSession promotes them into user_disliked_books at signup, so
   * they start filtering recommendations from the user's very first feed.
   */
  async saveSelections(
    id: string,
    chosenBookIds: number[],
    dislikedBookIds: number[] = [],
  ): Promise<{ readerType: string | null; books: { id: number; title: string; coverUrl: string | null }[] } | null> {
    const readerType = await fetchAndInferReaderType(chosenBookIds);

    const [updated] = await db
      .update(guestSessions)
      .set({
        chosenBookIds,
        dislikedBookIds: [...new Set(dislikedBookIds)],
        readerType: readerType ?? undefined,
      })
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
