import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { deviceTokens } from '../db/schema';

export const deviceTokensService = {
  // Upserts on the token itself — re-registering an existing token (e.g. a
  // different account signing in on the same device) reassigns ownership.
  async register(
    userId: number,
    fcmToken: string,
    platform: 'ios' | 'android',
  ): Promise<typeof deviceTokens.$inferSelect> {
    const [row] = await db
      .insert(deviceTokens)
      .values({ userId, fcmToken, platform })
      .onConflictDoUpdate({
        target: deviceTokens.fcmToken,
        set: { userId, platform, lastSeenAt: new Date() },
      })
      .returning();
    return row;
  },

  async unregister(userId: number, fcmToken: string): Promise<void> {
    const result = await db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.fcmToken, fcmToken), eq(deviceTokens.userId, userId)))
      .returning({ id: deviceTokens.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Device token not found'), { statusCode: 404 });
    }
  },
};
