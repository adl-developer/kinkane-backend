import cron, { ScheduledTask } from 'node-cron';
import { and, eq, gt, lte, ne, or, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, userSubscriptions } from '../db/schema';
import { stripe, isStripeConfigured, isFoundingPriceId } from '../lib/stripe';
import { enqueueEmail } from '../lib/email-queue';
import { logger } from '../lib/logger';
import { schedulesService } from '../services/subscriptions/schedules.service';
import type Stripe from 'stripe';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function linePriceId(line: Stripe.InvoiceLineItem): string | null {
  const price = line.pricing?.price_details?.price;
  return price == null ? null : typeof price === 'string' ? price : price.id;
}

/**
 * Daily at 09:00 UTC: emails every website (Stripe) subscriber whose renewal
 * is within the next 7 days, once per renewal. App Store subscribers are left
 * to Apple, which bills them and sends its own notices. Cancelled-at-period-end
 * subscriptions don't renew, so they get nothing.
 *
 * The amount comes from Stripe's invoice preview, so the email quotes exactly
 * what will be charged — including the founding-to-standard switch, which
 * gets its own wording.
 *
 * Each subscriber is claimed (`renewal_reminder_sent_for` set by a conditional
 * UPDATE) before Stripe is called, so workers running this at the same moment
 * neither double-send nor repeat each other's Stripe calls. A failure after
 * the claim releases it for the next day's run.
 */
export async function sendDueRenewalReminders(now: Date = new Date()): Promise<number> {
  if (!isStripeConfigured()) return 0;

  const due = await db
    .select({
      userId: userSubscriptions.userId,
      plan: userSubscriptions.plan,
      pendingPlan: userSubscriptions.pendingPlan,
      priceId: userSubscriptions.priceId,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      stripeSubscriptionId: userSubscriptions.stripeSubscriptionId,
      email: users.email,
      name: users.name,
    })
    .from(userSubscriptions)
    .innerJoin(users, eq(users.id, userSubscriptions.userId))
    .where(
      and(
        eq(userSubscriptions.status, 'active'),
        eq(userSubscriptions.billingProvider, 'stripe'),
        eq(userSubscriptions.cancelAtPeriodEnd, false),
        gt(userSubscriptions.currentPeriodEnd, now),
        lte(userSubscriptions.currentPeriodEnd, new Date(now.getTime() + WEEK_MS)),
        or(
          isNull(userSubscriptions.renewalReminderSentFor),
          ne(userSubscriptions.renewalReminderSentFor, userSubscriptions.currentPeriodEnd),
        ),
      ),
    );

  let sent = 0;
  for (const row of due) {
    if (!row.stripeSubscriptionId || !row.currentPeriodEnd || !row.plan) continue;

    // Claim before calling Stripe, so every worker running this sweep at once
    // makes one Stripe call per subscriber between them, not one each.
    const [claimed] = await db
      .update(userSubscriptions)
      .set({ renewalReminderSentFor: row.currentPeriodEnd })
      .where(
        and(
          eq(userSubscriptions.userId, row.userId),
          eq(userSubscriptions.currentPeriodEnd, row.currentPeriodEnd),
          sql`${userSubscriptions.renewalReminderSentFor} IS DISTINCT FROM ${userSubscriptions.currentPeriodEnd}`,
        ),
      )
      .returning({ userId: userSubscriptions.userId });
    if (!claimed) continue;

    try {
      const onFounding = isFoundingPriceId(row.priceId);
      // Make sure the founding-to-standard switch is in Stripe before asking
      // what the renewal costs: right after deploy, or when invoice.paid's
      // attach failed, it may not be there yet. Idempotent.
      if (onFounding) {
        await schedulesService.scheduleFoundingRollover(row.stripeSubscriptionId, row.userId);
      }

      const preview = await stripe().invoices.createPreview({ subscription: row.stripeSubscriptionId });

      // "Founding price ends" only when the renewal's own price is no longer a
      // founding one. Comparing totals would misfire on tax, credit or discounts.
      let foundingAmountCents: number | null = null;
      if (onFounding && !preview.lines.data.some((l) => isFoundingPriceId(linePriceId(l)))) {
        foundingAmountCents = (await stripe().prices.retrieve(row.priceId!)).unit_amount;
      }

      await enqueueEmail('subscription-renewal-reminder', {
        to: row.email,
        name: row.name,
        // A pending switch takes effect at this renewal, so that's the plan billed.
        plan: row.pendingPlan ?? row.plan,
        renewsAt: row.currentPeriodEnd.toISOString(),
        // Before any account credit is applied: what the renewal costs.
        amountCents: preview.total,
        currency: preview.currency,
        foundingAmountCents,
      });
      sent += 1;
    } catch (err) {
      logger.error('Renewal reminder failed for subscriber — will retry tomorrow', {
        userId: row.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Release our claim, so tomorrow's run retries.
      await db
        .update(userSubscriptions)
        .set({ renewalReminderSentFor: null })
        .where(
          and(
            eq(userSubscriptions.userId, row.userId),
            eq(userSubscriptions.renewalReminderSentFor, row.currentPeriodEnd),
          ),
        )
        .catch(() => undefined);
    }
  }

  if (sent > 0) logger.info('Renewal reminders queued', { sent });
  return sent;
}

export function startRenewalReminderCron(): ScheduledTask {
  const task = cron.schedule('0 9 * * *', async () => {
    try {
      await sendDueRenewalReminders();
    } catch (err) {
      logger.error('Renewal reminder sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Renewal reminder cron started (daily 09:00 UTC)');
  return task;
}

export function stopRenewalReminderCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Renewal reminder cron stopped');
}
