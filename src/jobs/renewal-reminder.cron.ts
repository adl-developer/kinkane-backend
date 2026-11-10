import cron, { ScheduledTask } from 'node-cron';
import { and, eq, gt, lte, ne, or, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, userSubscriptions } from '../db/schema';
import { stripe, isStripeConfigured, isFoundingPriceId } from '../lib/stripe';
import { enqueueEmail } from '../lib/email-queue';
import { logger } from '../lib/logger';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
 * `renewal_reminder_sent_for` is claimed with a conditional UPDATE, so workers
 * running this at the same moment can't double-send.
 */
export async function sendDueRenewalReminders(now: Date = new Date()): Promise<number> {
  if (!isStripeConfigured()) return 0;

  const due = await db
    .select({
      userId: userSubscriptions.userId,
      plan: userSubscriptions.plan,
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
    try {
      const preview = await stripe().invoices.createPreview({ subscription: row.stripeSubscriptionId });

      // Founding is one period, so a founding-priced renewal is the one that
      // moves to standard. Say so only if Stripe agrees the amount changes —
      // if the rollover failed to attach, it would still bill founding.
      let foundingAmountCents: number | null = null;
      if (isFoundingPriceId(row.priceId)) {
        const founding = await stripe().prices.retrieve(row.priceId!);
        if (founding.unit_amount != null && founding.unit_amount !== preview.amount_due) {
          foundingAmountCents = founding.unit_amount;
        }
      }

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

      await enqueueEmail('subscription-renewal-reminder', {
        to: row.email,
        name: row.name,
        plan: row.plan,
        renewsAt: row.currentPeriodEnd.toISOString(),
        amountCents: preview.amount_due,
        currency: preview.currency,
        foundingAmountCents,
      });
      sent += 1;
    } catch (err) {
      logger.error('Renewal reminder failed for subscriber — will retry tomorrow', {
        userId: row.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Release a claim made before the failure, so tomorrow's run retries.
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
