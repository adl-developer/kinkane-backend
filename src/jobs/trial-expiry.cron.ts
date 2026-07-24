import cron, { ScheduledTask } from 'node-cron';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { userSubscriptions, subscriptionEvents } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * Runs hourly and flips any trialing subscription whose trial_ends_at has
 * passed to status=expired, tier=free. This is the backstop for accounts
 * that never hit getMe (which does the same flip lazily on read) — without
 * this sweep, a dormant user's trial would never actually resolve to expired
 * in the DB, which would undercount expirations in any reporting.
 *
 * Cron expression: "0 * * * *"  →  at minute 0 of every hour.
 *
 * NOTE: In a multi-process cluster this job runs in every worker
 * simultaneously. Each row is only updated while it still matches
 * status='trialing', so concurrent runs can't double-flip or double-log the
 * same row.
 */
export function startTrialExpiryCron(): ScheduledTask {
  const task = cron.schedule('0 * * * *', async () => {
    try {
      const candidates = await db
        .select({ id: userSubscriptions.id, userId: userSubscriptions.userId, trialEndsAt: userSubscriptions.trialEndsAt })
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.status, 'trialing'), lt(userSubscriptions.trialEndsAt, new Date())));

      let expiredCount = 0;
      for (const row of candidates) {
        const expiredAt = new Date();
        await db.transaction(async (tx) => {
          const updated = await tx
            .update(userSubscriptions)
            .set({ status: 'expired', tier: 'free', trialExpiredAt: expiredAt, updatedAt: expiredAt })
            .where(and(eq(userSubscriptions.id, row.id), eq(userSubscriptions.status, 'trialing')))
            .returning({ id: userSubscriptions.id });

          if (updated.length > 0) {
            await tx.insert(subscriptionEvents).values({
              userId: row.userId,
              event: 'expired',
              previousTrialEndsAt: row.trialEndsAt,
              newTrialEndsAt: null,
            });
            expiredCount += 1;
          }
        });
      }

      if (expiredCount > 0) {
        logger.info('Trial expiry sweep complete', { expired: expiredCount });
      }
    } catch (err) {
      logger.error('Trial expiry sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Trial expiry cron started (hourly)');
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopTrialExpiryCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Trial expiry cron stopped');
}
