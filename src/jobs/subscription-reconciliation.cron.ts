import cron, { ScheduledTask } from 'node-cron';
import { and, eq, isNotNull, isNull, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import { userSubscriptions } from '../db/schema';
import { stripe, isStripeConfigured, planForPriceId, isFoundingPriceId } from '../lib/stripe';
import { subscriptionStateService } from '../services/subscriptions/state.service';
import { entitlementsService } from '../services/subscriptions/entitlements.service';
import { appleSubscriptionsService } from '../services/subscriptions/apple.service';
import { isAppleConfigured } from '../lib/apple-store';
import { logger } from '../lib/logger';

/**
 * Daily sweep that re-reads every paid subscription from whoever bills it —
 * Stripe or Apple — and repairs any that drifted.
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
    await reconcileStripe();
    await reconcileApple();
  });

  logger.info('Subscription reconciliation cron started (daily 03:15 UTC)');
  return task;
}

async function reconcileStripe(): Promise<void> {
  if (!isStripeConfigured()) return;

  try {
    // Every row with a Stripe subscription except those now billed by Apple,
    // which may still carry the id of a Stripe subscription that ended —
    // re-reading that would "repair" the user down to cancelled. A null
    // provider counts as Stripe (see getBillingProvider) and is labelled below.
    const rows = await db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          isNotNull(userSubscriptions.stripeSubscriptionId),
          or(
            isNull(userSubscriptions.billingProvider),
            eq(userSubscriptions.billingProvider, 'stripe'),
          ),
        ),
      );

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
          row.currentPeriodEnd?.getTime() !== currentPeriodEnd?.getTime() ||
          row.billingProvider !== 'stripe';

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
            billingProvider: 'stripe',
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
}

/**
 * Same safety net for App Store subscriptions. Only rows Apple may still be
 * billing — an ended chain has nothing left to drift, and a resubscribe
 * arrives through a notification or the app's verify call.
 */
async function reconcileApple(): Promise<void> {
  if (!isAppleConfigured()) return;

  try {
    const rows = await db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.billingProvider, 'apple'),
          isNotNull(userSubscriptions.appleOriginalTransactionId),
          inArray(userSubscriptions.status, ['active', 'past_due']),
        ),
      );

    let repaired = 0;
    for (const row of rows) {
      try {
        if (await appleSubscriptionsService.reconcile(row)) repaired += 1;
      } catch (err) {
        logger.error('Failed to reconcile an App Store subscription', {
          userId: row.userId,
          appleOriginalTransactionId: row.appleOriginalTransactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('App Store subscription reconciliation complete', {
      checked: rows.length,
      repaired,
    });
  } catch (err) {
    logger.error('App Store subscription reconciliation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function stopSubscriptionReconciliationCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Subscription reconciliation cron stopped');
}
