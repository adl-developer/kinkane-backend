import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db';
import { guestSessions, type GuestSession, type Dislikes } from '../db/schema';
import { config } from '../config';

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
   * Saves the user's 5 chosen books against an existing guest session.
   * Returns false if the session doesn't exist or has expired.
   */
  async saveSelections(id: string, chosenBookIds: number[]): Promise<boolean> {
    const [updated] = await db
      .update(guestSessions)
      .set({ chosenBookIds })
      .where(
        and(
          eq(guestSessions.id, id),
          gt(guestSessions.expiresAt, new Date()),
        ),
      )
      .returning({ id: guestSessions.id });

    return !!updated;
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
