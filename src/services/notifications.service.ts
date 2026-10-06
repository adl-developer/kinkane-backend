import { eq, and, desc, sql, isNull, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { notifications, followRequests, users, type NotificationType } from '../db/schema';

export interface NotificationItem {
  id: number;
  type: NotificationType;
  createdAt: Date;
  readAt: Date | null;
  data: Record<string, unknown>;
}

const sender = alias(users, 'sender');

// A friend request still waiting on an answer. Read from follow_requests, the
// source of truth, rather than the notification's mirrored `data.status`.
const isPendingFriendRequest = sql`EXISTS (
  SELECT 1 FROM ${followRequests}
  WHERE ${followRequests.id} = ${notifications.followRequestId} AND ${followRequests.status} = 'pending'
)`;

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
          // Friend requests show the sender as they are now, not as they were
          // when the request was sent — a renamed sender or a removed photo
          // would otherwise linger on the card until it was answered.
          requestStatus: followRequests.status,
          senderName: sender.name,
          senderPhotoUrl: sender.photoUrl,
        })
        .from(notifications)
        .leftJoin(followRequests, eq(followRequests.id, notifications.followRequestId))
        .leftJoin(sender, eq(sender.id, followRequests.senderId))
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
      notifications: rows.map(({ requestStatus, senderName, senderPhotoUrl, ...row }) => ({
        ...row,
        type: row.type as NotificationType,
        data:
          requestStatus && senderName !== null
            ? { ...(row.data as Record<string, unknown>), status: requestStatus, senderName, senderPhotoUrl }
            : (row.data as Record<string, unknown>),
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

  /**
   * Removes one notification from the caller's feed, read or not. A friend
   * request still waiting on an answer can't be cleared — it would vanish
   * from the feed while still needing a response — so that is a 409, and an
   * id that isn't the caller's is a 404.
   */
  async clearOne(userId: number, id: number): Promise<void> {
    const deleted = await db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), sql`NOT ${isPendingFriendRequest}`))
      .returning({ id: notifications.id });

    if (deleted.length > 0) return;

    const [kept] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .limit(1);

    if (kept) {
      throw Object.assign(new Error('Accept or decline this friend request before clearing it'), {
        statusCode: 409,
        code: 'FRIEND_REQUEST_PENDING',
      });
    }
    throw Object.assign(new Error('Notification not found'), { statusCode: 404 });
  },

  /** Clears the caller's whole feed except friend requests still waiting on an answer. */
  async clearAll(userId: number): Promise<{ cleared: number }> {
    const deleted = await db
      .delete(notifications)
      .where(and(eq(notifications.userId, userId), sql`NOT ${isPendingFriendRequest}`))
      .returning({ id: notifications.id });
    return { cleared: deleted.length };
  },
};
