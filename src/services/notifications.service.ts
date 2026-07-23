import { eq, and, desc, sql, isNull, inArray } from 'drizzle-orm';
import { db } from '../db';
import { notifications, followRequests, users } from '../db/schema';
import { mergeNotifications, type NotificationItem } from '../lib/merge-notifications';

export type { NotificationItem };

export const notificationsService = {
  // Fetches both sources independently — each overfetched up to offset+limit —
  // then hands off to the pure mergeNotifications helper to sort and slice.
  async list(
    userId: number,
    limit: number,
    offset: number,
  ): Promise<{ notifications: NotificationItem[]; total: number; unreadCount: number }> {
    const fetchDepth = offset + limit;

    const [notifRows, friendReqRows, [notifCount], [friendReqCount], [unreadNotifCount], [pendingFriendReqCount]] =
      await Promise.all([
        db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, userId))
          .orderBy(desc(notifications.createdAt))
          .limit(fetchDepth),
        db
          .select({
            id: followRequests.id,
            senderId: followRequests.senderId,
            senderName: users.name,
            senderPhotoUrl: users.photoUrl,
            status: followRequests.status,
            createdAt: followRequests.createdAt,
          })
          .from(followRequests)
          .innerJoin(users, eq(users.id, followRequests.senderId))
          .where(eq(followRequests.receiverId, userId))
          .orderBy(desc(followRequests.createdAt))
          .limit(fetchDepth),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(notifications).where(eq(notifications.userId, userId)),
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(followRequests)
          .where(eq(followRequests.receiverId, userId)),
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(notifications)
          .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(followRequests)
          .where(and(eq(followRequests.receiverId, userId), eq(followRequests.status, 'pending'))),
      ]);

    return {
      notifications: mergeNotifications(notifRows, friendReqRows, limit, offset),
      total: notifCount.count + friendReqCount.count,
      unreadCount: unreadNotifCount.count + pendingFriendReqCount.count,
    };
  },

  async markRead(userId: number, ids: number[]): Promise<void> {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids)));
  },
};
