import type Stripe from 'stripe';
import { stripe, planForPriceId, resolvePrice } from '../../lib/stripe';
import { logger } from '../../lib/logger';

/**
 * Subscription schedules — the two-phase Founding Member price rollover, and
 * getting a subscription back out from under one.
 *
 * A schedule is how a Founding Member's introductory price is held for exactly
 * one term and then rolled onto standard pricing. The cost of that is that
 * Stripe then treats the schedule as the owner of the subscription's lifecycle:
 *
 *     The subscription is managed by the subscription schedule
 *     `sub_sched_...`, and updating any cancelation behavior directly is not
 *     allowed. Please update the schedule instead.
 *
 * So a schedule-managed subscription cannot be cancelled through the
 * Subscriptions API at all — the call is rejected outright. Releasing the
 * schedule first is what makes cancellation possible again: release leaves the
 * subscription exactly as it is and only detaches the remaining phases.
 *
 * Kept in its own module because both ends of that need it — checkout wiring
 * the schedule up, cancellation tearing it down — and having cancellation
 * import the webhook service to reach it had the dependency the wrong way
 * round.
 */

function firstPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

/** The schedule managing this subscription, if one currently is. */
export function scheduleIdOf(subscription: Stripe.Subscription): string | null {
  const schedule = subscription.schedule;
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

export const schedulesService = {
  /**
   * Converts a new Founding Member's subscription into a two-phase schedule:
   * their introductory price for exactly one term, then standard pricing.
   *
   * Done after checkout rather than during it because a schedule can only be
   * created from a subscription that already exists. A failure is logged but
   * never rethrown — the customer has paid and must not be left un-entitled
   * because a future price rollover couldn't be arranged; the daily
   * reconciliation surfaces any that didn't take.
   */
  async attachFounding(subscription: Stripe.Subscription, userId: number): Promise<void> {
    try {
      // Already managed — `from_subscription` would be rejected, and a second
      // schedule is never what we want.
      if (scheduleIdOf(subscription)) return;

      const priceId = firstPriceId(subscription);
      const plan = planForPriceId(priceId);
      if (!plan) return;

      const { standardPriceId } = resolvePrice(plan);
      // Already on standard pricing — there is no rollover left to schedule.
      if (!standardPriceId || standardPriceId === priceId) return;

      const schedule = await stripe().subscriptionSchedules.create({
        from_subscription: subscription.id,
      });

      await stripe().subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          // Phase 1: the locked-in founding price, one term only.
          {
            items: [{ price: priceId!, quantity: 1 }],
            start_date: schedule.phases[0].start_date,
            end_date: schedule.phases[0].end_date,
          },
          // Phase 2: standard pricing, open-ended.
          {
            items: [{ price: standardPriceId, quantity: 1 }],
          },
        ],
      });

      logger.info('Attached Founding Member price schedule', {
        userId,
        subscriptionId: subscription.id,
        scheduleId: schedule.id,
        foundingPriceId: priceId,
        standardPriceId,
      });
    } catch (err) {
      logger.error('Failed to attach Founding Member price schedule — subscription still active', {
        userId,
        subscriptionId: subscription.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Detaches whatever schedule is managing a subscription, so cancellation
   * behaviour can be set on the subscription directly.
   *
   * Returns the released schedule id, or null when there was nothing attached —
   * which is the normal case for everyone who isn't a Founding Member.
   *
   * Unlike `attachFounding`, a failure here **is** rethrown. This runs on the
   * cancellation path, and a swallowed error would mean telling a user their
   * subscription is cancelled while Stripe carries on billing them.
   */
  async releaseFrom(subscriptionId: string, userId: number): Promise<string | null> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    const scheduleId = scheduleIdOf(subscription);
    if (!scheduleId) return null;

    await stripe().subscriptionSchedules.release(scheduleId);

    logger.info('Released subscription from its price schedule', {
      userId,
      subscriptionId,
      scheduleId,
    });

    return scheduleId;
  },
};
