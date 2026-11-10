import type Stripe from 'stripe';
import {
  stripe,
  planForPriceId,
  resolvePrice,
  isFoundingPriceId,
} from '../../lib/stripe';
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
 *   1. **Founding → standard.** Founding pricing covers one billing period;
 *      the next renewal bills standard.
 *      See `scheduleFoundingRollover`, called from the invoice.paid webhook.
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
 * The price id a plan change switches to, at the end of the current period.
 * Always standard: founding covers one period only, and a change takes effect
 * at a renewal, which is after it.
 */
function pickTargetPriceId(targetPlan: SubscriptionPlan): string {
  return resolvePrice(targetPlan, null).priceId;
}

/**
 * Every phase we write carries the subscription's metadata. Stripe applies a
 * phase's metadata to the subscription when the phase starts, and losing
 * `foundingEndsAt` (or `userId`) there would misread the founding window.
 */
function metadataOf(subscription: Stripe.Subscription): Stripe.MetadataParam {
  return { ...subscription.metadata };
}

export const schedulesService = {
  /**
   * Attaches a rollover from a founding price to its standard equivalent,
   * timed to happen at the subscriber's very next renewal: founding covers one
   * billing period. Idempotent, so it's safe to invoke on every invoice.paid
   * (and after a release).
   *
   * Also a no-op while a schedule has a change still pending (an earlier
   * rollover, or a plan change). A schedule whose last phase is already
   * running — a plan change onto a founding price — is released and replaced,
   * or that founding price would never end.
   *
   * Errors are swallowed with a loud log rather than rethrown: this is a
   * webhook-driven housekeeping step and a Stripe blip must not turn a
   * successful renewal into a retried webhook.
   */
  async scheduleFoundingRollover(
    subscriptionOrId: string | Stripe.Subscription,
    userId: number,
  ): Promise<void> {
    try {
      // Accept either an id (from a webhook callsite that has only the id) or
      // an already-fetched Subscription (from `reactivate`, which has just
      // updated it and knows its own state). Avoids one round-trip and, more
      // importantly, avoids racing against the write that produced it.
      const subscription =
        typeof subscriptionOrId === 'string'
          ? await stripe().subscriptions.retrieve(subscriptionOrId)
          : subscriptionOrId;
      const subscriptionId = subscription.id;

      const priceId = firstPriceId(subscription);
      if (!isFoundingPriceId(priceId)) return;

      const plan = planForPriceId(priceId);
      if (!plan) return;

      const { standardPriceId } = resolvePrice(plan, null);
      if (standardPriceId === priceId) return;

      // Founding is one billing period, so the rollover is always due at the
      // next renewal — legacy subscriptions included (changed 2026-11-10).
      const existingScheduleId = scheduleIdOf(subscription);
      if (existingScheduleId) {
        const existing = await stripe().subscriptionSchedules.retrieve(existingScheduleId);
        const lastPhase = existing.phases[existing.phases.length - 1];
        if (!lastPhase || lastPhase.start_date > Math.floor(Date.now() / 1000)) return;
        await stripe().subscriptionSchedules.release(existingScheduleId);
      }

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
            metadata: metadataOf(subscription),
          },
          { items: [{ price: standardPriceId, quantity: 1 }], metadata: metadataOf(subscription) },
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
        subscriptionId: typeof subscriptionOrId === 'string' ? subscriptionOrId : subscriptionOrId.id,
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
   * comes from `pickTargetPriceId` so founding members changing plans inside
   * their window stay on founding — see there for why.
   */
  async schedulePlanChange(
    subscriptionId: string,
    userId: number,
    targetPlan: SubscriptionPlan,
  ): Promise<void> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    const targetPriceId = pickTargetPriceId(targetPlan);
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
            metadata: metadataOf(subscription),
          },
          { items: [{ price: targetPriceId, quantity: 1 }], metadata: metadataOf(subscription) },
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
      metadata: metadataOf(subscription),
    }));

    const currentPhase = schedule.phases[currentPhaseIndex];
    const currentPhaseEnd = currentPhase.end_date ?? currentPeriodEnd;
    if (!currentPhaseEnd) {
      throw Object.assign(new Error('Cannot determine when the current phase ends'), {
        statusCode: 502,
        code: 'SCHEDULE_PHASE_INDETERMINATE',
      });
    }
    const currentPreserved = {
      items: currentPhase.items.map((it) => ({
        price: phaseItemPriceId(it),
        quantity: it.quantity ?? 1,
      })),
      start_date: currentPhase.start_date,
      end_date: currentPhaseEnd,
      metadata: metadataOf(subscription),
    };

    const newFuture = { items: [{ price: targetPriceId, quantity: 1 }], metadata: metadataOf(subscription) };

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

