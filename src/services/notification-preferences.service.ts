import { eq } from 'drizzle-orm';
import { db } from '../db';
import { notificationPreferences } from '../db/schema';

export interface NotificationPrefsUpdate {
  newBookSuggestions?: boolean;
  rateReviewReminders?: boolean;
  friendRequests?: boolean;
  comments?: boolean;
  likes?: boolean;
}

export const notificationPreferencesService = {
  async get(userId: number): Promise<typeof notificationPreferences.$inferSelect> {
    const [existing] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);

    if (existing) return existing;

    // Row may be missing for users created before this feature shipped — insert defaults
    const [created] = await db
      .insert(notificationPreferences)
      .values({ userId })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    // Concurrent insert won the race — fetch what was just inserted
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);

    return row;
  },

  async update(
    userId: number,
    patch: NotificationPrefsUpdate,
  ): Promise<typeof notificationPreferences.$inferSelect> {
    const [updated] = await db
      .update(notificationPreferences)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, userId))
      .returning();

    if (!updated) {
      // Row didn't exist yet — create with defaults then apply patch
      const [created] = await db
        .insert(notificationPreferences)
        .values({ userId, ...patch })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { ...patch, updatedAt: new Date() },
        })
        .returning();
      return created;
    }

    return updated;
  },

  // Utility used by email dispatchers to check a single preference before sending
  async isEnabled(userId: number, pref: keyof NotificationPrefsUpdate): Promise<boolean> {
    const prefs = await this.get(userId);
    return prefs[pref] ?? true;
  },
};
