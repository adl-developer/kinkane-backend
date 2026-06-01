import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { ShelfVisibility } from '../db/schema/users';

export interface UserSettings {
  shelfVisibility: ShelfVisibility;
}

export const userSettingsService = {
  async getUserSettings(userId: number): Promise<UserSettings> {
    const [user] = await db
      .select({ shelfVisibility: users.shelfVisibility })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    return { shelfVisibility: user.shelfVisibility };
  },

  async updateShelfVisibility(userId: number, visibility: ShelfVisibility): Promise<void> {
    await db
      .update(users)
      .set({ shelfVisibility: visibility, updatedAt: new Date() })
      .where(eq(users.id, userId));
  },
};
