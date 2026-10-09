import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { ShelfVisibility, ReaderType } from '../db/schema/users';
import { readerTypeTagline } from '../lib/reader-type-taglines';
import { nextUsernameChangeAt } from '../lib/username';

export interface UserSettings {
  name: string;
  username: string | null;
  usernameChangedAt: Date | null;
  /** When the username may next be changed; null when it can be changed now. */
  nextUsernameChangeAt: Date | null;
  photoUrl: string | null;
  shelfVisibility: ShelfVisibility;
  readerType: ReaderType | null;
  readerTypeTagline: string | null;
}

export const userSettingsService = {
  async getUserSettings(userId: number): Promise<UserSettings> {
    const [user] = await db
      .select({
        name: users.name,
        username: users.username,
        usernameChangedAt: users.usernameChangedAt,
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

    const nextChange = nextUsernameChangeAt(user.usernameChangedAt);
    return {
      name: user.name,
      username: user.username,
      usernameChangedAt: user.usernameChangedAt,
      nextUsernameChangeAt: nextChange && nextChange > new Date() ? nextChange : null,
      photoUrl: user.photoUrl ?? null,
      shelfVisibility: user.shelfVisibility,
      readerType: user.readerType ?? null,
      readerTypeTagline: readerTypeTagline(user.readerType),
    };
  },

  async updateShelfVisibility(userId: number, visibility: ShelfVisibility): Promise<void> {
    await db
      .update(users)
      .set({ shelfVisibility: visibility, updatedAt: new Date() })
      .where(eq(users.id, userId));
  },

  async updateProfile(
    userId: number,
    data: { name?: string; photoUrl?: string | null; phone?: string | null },
  ): Promise<{ name: string; photoUrl: string | null; phone: string | null }> {
    const [updated] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ name: users.name, photoUrl: users.photoUrl, phone: users.phone });

    if (!updated) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    return {
      name: updated.name,
      photoUrl: updated.photoUrl ?? null,
      phone: updated.phone ?? null,
    };
  },
};
