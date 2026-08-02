import cron, { ScheduledTask } from 'node-cron';
import { and, eq, lt, isNull } from 'drizzle-orm';
import { db } from '../db';
import { userSubscriptions } from '../db/schema';
import { subscriptionStateService } from '../services/subscriptions/state.service';
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
 * The flip itself lives in subscriptionStateService.expireTrialIfDue, shared
 * with getMe, which re-checks its guards inside the UPDATE. That matters here
 * for two reasons: in a multi-process cluster this job runs in every worker
 * simultaneously, and a user can convert to paid in the gap between the SELECT
 * below and the UPDATE. Neither can double-flip a row or downgrade a payer.
 *
 * The candidate query also filters out rows with Stripe billing attached — the
 * guard inside the service is the correctness boundary, this is just avoiding
 * pointless work.
 */
export function startTrialExpiryCron(): ScheduledTask {
  const task = cron.schedule('0 * * * *', async () => {
    try {
      const candidates = await db
        .select()
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.status, 'trialing'),
            lt(userSubscriptions.trialEndsAt, new Date()),
            isNull(userSubscriptions.stripeSubscriptionId),
          ),
        );

      let expiredCount = 0;
      for (const row of candidates) {
        const updated = await subscriptionStateService.expireTrialIfDue(row);
        if (updated) expiredCount += 1;
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
