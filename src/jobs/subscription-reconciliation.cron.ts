import cron, { ScheduledTask } from 'node-cron';
import { isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { userSubscriptions } from '../db/schema';
import { stripe, isStripeConfigured, planForPriceId, isFoundingPriceId } from '../lib/stripe';
import { subscriptionStateService } from '../services/subscriptions/state.service';
import { entitlementsService } from '../services/subscriptions/entitlements.service';
import { logger } from '../lib/logger';

/**
 * Daily sweep that re-reads every Stripe-backed subscription from Stripe and
 * repairs any that drifted.
 *
 * Webhooks are the primary path and this is the safety net. Deliveries can be
 * lost, arrive out of order, or hit a handler that threw — and every one of
 * those failures is silent, showing up only as a user who paid and didn't get
 * access (or cancelled and kept it). Without a reconciliation pass, the only
 * detector for that is a support ticket.
 *
 * Runs at 03:15 UTC — off the hour, so it doesn't pile onto the trial-expiry
 * sweep, and outside peak traffic since it makes one Stripe call per subscriber.
 */
export function startSubscriptionReconciliationCron(): ScheduledTask {
  const task = cron.schedule('15 3 * * *', async () => {
    if (!isStripeConfigured()) return;

    try {
      const rows = await db
        .select()
        .from(userSubscriptions)
        .where(isNotNull(userSubscriptions.stripeSubscriptionId));

      let checked = 0;
      let repaired = 0;

      for (const row of rows) {
        checked += 1;
        try {
          const remote = await stripe().subscriptions.retrieve(row.stripeSubscriptionId!);
          const priceId = remote.items.data[0]?.price?.id ?? null;
          const periodEndSeconds = remote.items.data[0]?.current_period_end;
          const currentPeriodEnd =
            typeof periodEndSeconds === 'number' ? new Date(periodEndSeconds * 1000) : null;

          const status =
            remote.status === 'active' || remote.status === 'trialing'
              ? 'active'
              : remote.status === 'past_due'
                ? 'past_due'
                : remote.status === 'incomplete'
                  ? 'incomplete'
                  : 'cancelled';
          const tier = status === 'active' || status === 'past_due' ? 'plus' : 'free';

          const drifted =
            row.status !== status ||
            row.tier !== tier ||
            row.priceId !== priceId ||
            row.cancelAtPeriodEnd !== remote.cancel_at_period_end ||
            row.currentPeriodEnd?.getTime() !== currentPeriodEnd?.getTime();

          if (!drifted) continue;

          logger.warn('Subscription drifted from Stripe — repairing', {
            userId: row.userId,
            subscriptionId: row.stripeSubscriptionId,
            local: { status: row.status, tier: row.tier, priceId: row.priceId },
            remote: { status, tier, priceId },
          });

          const updated = await subscriptionStateService.applyState(
            row.userId,
            {
              tier,
              status,
              plan: planForPriceId(priceId),
              priceId,
              isFoundingMember: row.isFoundingMember || isFoundingPriceId(priceId),
              currentPeriodEnd,
              cancelAtPeriodEnd: remote.cancel_at_period_end,
            },
            { reason: 'reconciliation' },
          );

          if (updated) {
            await entitlementsService.invalidate(row.userId);
            repaired += 1;
          }
        } catch (err) {
          logger.error('Failed to reconcile a subscription', {
            userId: row.userId,
            subscriptionId: row.stripeSubscriptionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('Subscription reconciliation complete', { checked, repaired });
    } catch (err) {
      logger.error('Subscription reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Subscription reconciliation cron started (daily 03:15 UTC)');
  return task;
}

export function stopSubscriptionReconciliationCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Subscription reconciliation cron stopped');
}
