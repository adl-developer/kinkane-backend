import { eq } from 'drizzle-orm';
import { db } from '../db';
import { notificationPreferences, users } from '../db/schema';

export interface NotificationPrefsUpdate {
  marketingEmails?: boolean;
  newBookSuggestions?: boolean;
  rateReviewReminders?: boolean;
  friendRequests?: boolean;
  comments?: boolean;
  likes?: boolean;
}

/**
 * The flags one-click unsubscribe clears — the promotional group, and nothing
 * else. Declared here rather than inline in the route so the route, the tests
 * and any future admin tooling all agree on what "unsubscribed" means.
 *
 * Deliberately excludes `friendRequests`: a follow request is someone reaching
 * out to you, not us marketing at you, and it keeps sending after unsubscribe.
 */
export const UNSUBSCRIBE_FLAGS = [
  'marketingEmails',
  'newBookSuggestions',
  'rateReviewReminders',
] as const satisfies readonly (keyof NotificationPrefsUpdate)[];

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

  /**
   * Marketing gate keyed by email address rather than user id, because the
   * newsletter job carries only an address — there is no user context on that
   * path.
   *
   * Checked at the queue worker, not at the call site, so every newsletter
   * passes through it no matter who enqueues the job. A marketing send that
   * skips the opt-out check isn't just a bug, it's a CAN-SPAM/GDPR problem, so
   * this must not be something a caller can forget.
   *
   * An address with no user row returns true: the only newsletter recipients
   * today are registered users, so this is a can't-happen path rather than a
   * lead list. If we ever mail non-users we need a real suppression list —
   * neither this check nor the unsubscribe route can record an opt-out for an
   * address that has no account.
   */
  async isMarketingEnabledByEmail(email: string): Promise<boolean> {
    const [row] = await db
      .select({ marketingEmails: notificationPreferences.marketingEmails })
      .from(notificationPreferences)
      .innerJoin(users, eq(users.id, notificationPreferences.userId))
      .where(eq(users.email, email))
      .limit(1);

    return row?.marketingEmails ?? true;
  },
};
