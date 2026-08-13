import type Stripe from 'stripe';
import { stripe, planForPriceId, resolvePrice, isFoundingWindowOpen, isFoundingPriceId } from '../../lib/stripe';
import { logger } from '../../lib/logger';
import type { SubscriptionPlan } from '../../db/schema';

/**
 * Subscription schedules — deferring price changes to the next natural billing
 * boundary, and getting a subscription back out from under one.
 *
 * A schedule is Stripe's way of expressing "this subscription is at price A
 * for a while, then price B". It costs one hard rule that shapes every path
 * in and out of this file: while a schedule is attached, Stripe rejects any
 * cancellation set on the subscription directly:
 *
 *     The subscription is managed by the subscription schedule
 *     `sub_sched_...`, and updating any cancelation behavior directly is not
 *     allowed. Please update the schedule instead.
 *
 * So a schedule-managed subscription can only be cancelled after the schedule
 * is released. Release leaves the subscription running exactly as it is — it
 * just detaches the future price changes we had planned.
 *
 * The two rollovers that use this file are:
 *
 *   1. **Founding → standard.** Founding members keep founding pricing on
 *      every renewal until the offer window closes AND their current period
 *      ends. See `scheduleFoundingRollover`, called from the invoice.paid
 *      webhook once both conditions hold.
 *   2. **Plan change (monthly ↔ annual, or into/out of founding).** Deferred
 *      to the next natural renewal so nobody is billed the new plan's rate
 *      mid-cycle. See `schedulePlanChange`.
 */

function firstPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

function currentPeriodEndOf(subscription: Stripe.Subscription): number | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return typeof seconds === 'number' ? seconds : null;
}

/** The schedule managing this subscription, if one currently is. */
export function scheduleIdOf(subscription: Stripe.Subscription): string | null {
  const schedule = subscription.schedule;
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

/** A schedule phase item's price id, whether or not Stripe expanded it. */
function phaseItemPriceId(item: Stripe.SubscriptionSchedule.Phase.Item): string {
  return typeof item.price === 'string' ? item.price : item.price.id;
}

/**
 * The price id to switch to when a founding member changes plans mid-flight,
 * or when we're scheduling a new plan for anyone else.
 *
 * The rule: if the founding offer window is still open AND this subscriber
 * is already a founding member, keep them on founding pricing for the new
 * plan too. Otherwise fall back to standard pricing. Every founding rate is
 * eligibility-gated on the current window, so once it closes nobody can be
 * granted founding — including via a plan change from another founding plan.
 */
function pickTargetPriceId(targetPlan: SubscriptionPlan, isFoundingMember: boolean): string {
  const resolved = resolvePrice(targetPlan);
  if (isFoundingMember && resolved.isFounding && resolved.priceId !== resolved.standardPriceId) {
    return resolved.priceId;
  }
  return resolved.standardPriceId;
}

export const schedulesService = {
  /**
   * Attaches a rollover from a founding price to its standard equivalent,
   * timed to happen at the subscriber's very next renewal.
   *
   * Called from the invoice.paid webhook once the founding window has closed
   * and a renewal has been billed — the subscriber's current period runs to
   * completion on founding pricing, and the next one starts at standard. A
   * no-op when a schedule is already attached (an earlier call, or a pending
   * plan change) so it's safe to invoke every renewal.
   *
   * Errors are swallowed with a loud log rather than rethrown: this is a
   * webhook-driven housekeeping step and a Stripe blip must not turn a
   * successful renewal into a retried webhook.
   */
  async scheduleFoundingRollover(subscriptionId: string, userId: number): Promise<void> {
    try {
      const subscription = await stripe().subscriptions.retrieve(subscriptionId);
      if (scheduleIdOf(subscription)) return;

      const priceId = firstPriceId(subscription);
      if (!isFoundingPriceId(priceId)) return;

      const plan = planForPriceId(priceId);
      if (!plan) return;

      const { standardPriceId } = resolvePrice(plan);
      if (standardPriceId === priceId) return;

      const schedule = await stripe().subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });

      // The default schedule from `from_subscription` gives one phase that
      // matches the current subscription, ending at current_period_end.
      // Rewrite it as a two-phase run: keep phase 1 exactly as-is (founding
      // until this period ends) and append standard forever after.
      await stripe().subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          {
            items: [{ price: priceId!, quantity: 1 }],
            start_date: schedule.phases[0].start_date,
            end_date: schedule.phases[0].end_date,
          },
          { items: [{ price: standardPriceId, quantity: 1 }] },
        ],
      });

      logger.info('Scheduled founding-to-standard rollover for next renewal', {
        userId,
        subscriptionId,
        scheduleId: schedule.id,
        foundingPriceId: priceId,
        standardPriceId,
      });
    } catch (err) {
      logger.error('Failed to schedule founding rollover — subscription still active', {
        userId,
        subscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Detaches whatever schedule is managing a subscription, so cancellation
   * behaviour can be set on the subscription directly.
   *
   * Returns the released schedule id, or null when there was nothing attached.
   * A failure is rethrown: this runs on the cancellation path, and a
   * swallowed error would mean telling a user their subscription is cancelled
   * while Stripe carries on billing them.
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

  /**
   * Schedules a switch to `targetPlan` for the end of the current billing
   * period — never mid-cycle.
   *
   * Two shapes of write, both with the same guarantee:
   *
   *   1. **No schedule yet** — create a fresh two-phase schedule where phase 1
   *      matches the current price and ends at current_period_end, phase 2
   *      is the target price open-ended.
   *   2. **Already schedule-managed** — keep past and current phases exactly
   *      as they are (with the current phase's open end pinned to
   *      current_period_end if it had none) and append one new future phase
   *      for the target price. Any *future* phases that were pending get
   *      dropped: the user's latest intent wins.
   *
   * Never rewrites the currently active phase, which would cause Stripe to
   * pro-rate the switch and bill the new plan mid-cycle. The target price
   * comes from `pickTargetPriceId` so founding members changing plans during
   * the window stay on founding — see there for why.
   */
  async schedulePlanChange(
    subscriptionId: string,
    userId: number,
    targetPlan: SubscriptionPlan,
    isFoundingMember: boolean,
  ): Promise<void> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    const targetPriceId = pickTargetPriceId(targetPlan, isFoundingMember);
    const scheduleId = scheduleIdOf(subscription);
    const currentPeriodEnd = currentPeriodEndOf(subscription);

    if (!scheduleId) {
      const currentPriceId = firstPriceId(subscription);
      const schedule = await stripe().subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });
      await stripe().subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          {
            items: [{ price: currentPriceId!, quantity: 1 }],
            start_date: schedule.phases[0].start_date,
            end_date: schedule.phases[0].end_date,
          },
          { items: [{ price: targetPriceId, quantity: 1 }] },
        ],
      });

      logger.info('Scheduled plan change (new schedule)', {
        userId,
        subscriptionId,
        targetPlan,
        targetPriceId,
      });
      return;
    }

    const schedule = await stripe().subscriptionSchedules.retrieve(scheduleId);
    const now = Math.floor(Date.now() / 1000);
    const currentPhaseIndex = schedule.phases.findIndex(
      (p) => p.start_date <= now && (p.end_date === null || p.end_date > now),
    );

    if (currentPhaseIndex === -1) {
      // No active phase means the schedule is in a state Stripe should have
      // released. Refuse rather than write something we can't reason about.
      throw Object.assign(new Error('Subscription is between schedule phases'), {
        statusCode: 409,
      });
    }

    const preserved = schedule.phases.slice(0, currentPhaseIndex).map((phase) => ({
      items: phase.items.map((it) => ({
        price: phaseItemPriceId(it),
        quantity: it.quantity ?? 1,
      })),
      start_date: phase.start_date,
      end_date: phase.end_date ?? undefined,
    }));

    const currentPhase = schedule.phases[currentPhaseIndex];
    const currentPhaseEnd = currentPhase.end_date ?? currentPeriodEnd;
    if (!currentPhaseEnd) {
      throw Object.assign(new Error('Cannot determine when the current phase ends'), {
        statusCode: 502,
      });
    }
    const currentPreserved = {
      items: currentPhase.items.map((it) => ({
        price: phaseItemPriceId(it),
        quantity: it.quantity ?? 1,
      })),
      start_date: currentPhase.start_date,
      end_date: currentPhaseEnd,
    };

    const newFuture = { items: [{ price: targetPriceId, quantity: 1 }] };

    await stripe().subscriptionSchedules.update(scheduleId, {
      end_behavior: 'release',
      phases: [...preserved, currentPreserved, newFuture],
    });

    logger.info('Scheduled plan change (rewrote schedule)', {
      userId,
      subscriptionId,
      targetPlan,
      targetPriceId,
      preservedPhases: preserved.length + 1,
    });
  },
};

