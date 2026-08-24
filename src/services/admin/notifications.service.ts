import { desc, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { adminNotifications } from '../../db/schema';
import { logger } from '../../lib/logger';

type AdminNotificationType = 'report_filed' | 'order_received' | 'customer_registered' | 'order_delivered';

export const adminNotificationsService = {
  /**
   * Records something the console should know about.
   *
   * **Never throws.** Every caller is inside a flow that matters more than the
   * notification: a paid order, a signup, a filed report. Failing to write the
   * bell entry must not fail the thing it is describing, so this logs and
   * swallows.
   */
  async emit(input: {
    type: AdminNotificationType;
    title: string;
    body: string;
    orderId?: number;
    userId?: number;
    reportId?: number;
  }): Promise<void> {
    try {
      await db.insert(adminNotifications).values({
        type: input.type,
        title: input.title,
        body: input.body,
        orderId: input.orderId ?? null,
        userId: input.userId ?? null,
        reportId: input.reportId ?? null,
      });
    } catch (err) {
      logger.error('Failed to record admin notification', {
        type: input.type,
        error: (err as Error).message,
      });
    }
  },

  async list(limit = 20) {
    const [rows, [unread]] = await Promise.all([
      db.select().from(adminNotifications).orderBy(desc(adminNotifications.createdAt)).limit(limit),
      db
        .select({ n: sql<number>`count(*)` })
        .from(adminNotifications)
        .where(isNull(adminNotifications.readAt)),
    ]);

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        orderId: r.orderId,
        userId: r.userId,
        reportId: r.reportId,
        read: r.readAt !== null,
        createdAt: r.createdAt,
      })),
      unread: Number(unread.n),
    };
  },

  /**
   * Read state is shared across admins rather than per-person: with a small
   * team on one queue, "somebody has seen this" is the useful meaning, and a
   * per-admin join table is more machinery than the bell is worth.
   */
  async markAllRead(): Promise<{ marked: number }> {
    const updated = await db
      .update(adminNotifications)
      .set({ readAt: new Date() })
      .where(isNull(adminNotifications.readAt))
      .returning({ id: adminNotifications.id });
    return { marked: updated.length };
  },

  /** "Clear" empties the feed. The events themselves live on in their own tables. */
  async clear(): Promise<{ cleared: number }> {
    const deleted = await db.delete(adminNotifications).returning({ id: adminNotifications.id });
    return { cleared: deleted.length };
  },
};
