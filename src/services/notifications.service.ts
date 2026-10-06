import { eq, and, desc, sql, isNull, inArray } from 'drizzle-orm';
import { db } from '../db';
import { notifications, type NotificationType } from '../db/schema';

export interface NotificationItem {
  id: number;
  type: NotificationType;
  createdAt: Date;
  readAt: Date | null;
  data: Record<string, unknown>;
}

export const notificationsService = {
  async list(
    userId: number,
    limit: number,
    offset: number,
  ): Promise<{ notifications: NotificationItem[]; total: number; unreadCount: number }> {
    const [rows, [counts]] = await Promise.all([
      db
        .select({
          id: notifications.id,
          type: notifications.type,
          createdAt: notifications.createdAt,
          readAt: notifications.readAt,
          data: notifications.data,
        })
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
        .offset(offset),
      db
        .select({
          total: sql<number>`COUNT(*)::int`,
          unread: sql<number>`COUNT(*) FILTER (WHERE ${notifications.readAt} IS NULL)::int`,
        })
        .from(notifications)
        .where(eq(notifications.userId, userId)),
    ]);

    return {
      notifications: rows.map((row) => ({
        ...row,
        type: row.type as NotificationType,
        data: row.data as Record<string, unknown>,
      })),
      total: counts.total,
      unreadCount: counts.unread,
    };
  },

  async markRead(userId: number, ids: number[]): Promise<void> {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids), isNull(notifications.readAt)));
  },
};
