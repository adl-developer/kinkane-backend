import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { ShelfVisibility, ReaderType } from '../db/schema/users';

export interface UserSettings {
  name: string;
  photoUrl: string | null;
  shelfVisibility: ShelfVisibility;
  readerType: ReaderType | null;
}

export const userSettingsService = {
  async getUserSettings(userId: number): Promise<UserSettings> {
    const [user] = await db
      .select({
        name: users.name,
        photoUrl: users.photoUrl,
        shelfVisibility: users.shelfVisibility,
        readerType: users.readerType,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    return { name: user.name, photoUrl: user.photoUrl ?? null, shelfVisibility: user.shelfVisibility, readerType: user.readerType ?? null };
  },

  async updateShelfVisibility(userId: number, visibility: ShelfVisibility): Promise<void> {
    await db
      .update(users)
      .set({ shelfVisibility: visibility, updatedAt: new Date() })
      .where(eq(users.id, userId));
  },

  async updateProfile(
    userId: number,
    data: { name?: string; photoUrl?: string | null },
  ): Promise<{ name: string; photoUrl: string | null }> {
    const [updated] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ name: users.name, photoUrl: users.photoUrl });

    if (!updated) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    return { name: updated.name, photoUrl: updated.photoUrl ?? null };
  },
};
