import { and, eq, isNull, desc, lte, gt, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  userSubscriptions,
  subscriptionEvents,
  subscriptionStateHistory,
  getEffectiveTier,
} from '../../db/schema';
import type {
  UserSubscription,
  SubscriptionStateHistory,
  SubscriptionTier,
  SubscriptionStatus,
  SubscriptionPlan,
} from '../../db/schema';
import { logger } from '../../lib/logger';

/**
 * The single writer for subscription state.
 *
 * Every path that changes what a user is subscribed to — signup, trial expiry,
 * Stripe webhooks, admin action, reconciliation — goes through `applyState`
 * here. That is deliberate: `user_subscriptions` holds only current state, and
 * the history table is only trustworthy if nothing writes the current row
 * without also closing out the previous interval. One writer is what keeps
 * those two in step.
 */

/** Either the root db handle or an open transaction. */
export type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Why a state transition happened. Stored verbatim on the history row. */
export type StateChangeReason =
  | 'signup'
  | 'trial_expired'
  | 'trial_extended'
  | 'checkout_completed'
  | 'invoice_paid'
  | 'payment_failed'
  | 'subscription_updated'
  | 'subscription_deleted'
  | 'reconciliation'
  // Only written by migration 0030, which opened an interval for every
  // subscription that existed before this table did.
  | 'backfill';

/** The fields that together define "what this user's subscription is". */
export interface SubscriptionState {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  plan?: SubscriptionPlan | null;
  priceId?: string | null;
  isFoundingMember?: boolean;
  trialEndsAt?: Date | null;
  trialExpiredAt?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

export interface ApplyStateOptions {
  reason: StateChangeReason;
  /** Stripe event id that caused this, when one did. */
  sourceEventId?: string | null;
  /** Transaction to join. Defaults to the root handle. */
  tx?: DbHandle;
  /**
   * Extra guard on the UPDATE. The row is only written if it still matches —
   * this is how concurrent writers (a webhook and the trial cron landing at the
   * same moment) resolve without locking. Returns null when it doesn't match.
   */
  expectStatus?: SubscriptionStatus;
  /** Only write if the row has no Stripe subscription attached. */
  expectNoStripeSubscription?: boolean;
}

/** The subset of history columns that decide whether state actually changed. */
function isSameState(row: SubscriptionStateHistory, next: UserSubscription): boolean {
  return (
    row.tier === next.tier &&
    row.status === next.status &&
    row.plan === next.plan &&
    row.priceId === next.priceId &&
    row.isFoundingMember === next.isFoundingMember &&
    row.cancelAtPeriodEnd === next.cancelAtPeriodEnd &&
    row.stripeSubscriptionId === next.stripeSubscriptionId &&
    sameTime(row.currentPeriodEnd, next.currentPeriodEnd) &&
    sameTime(row.trialEndsAt, next.trialEndsAt)
  );
}

function sameTime(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

export const subscriptionStateService = {
  /**
   * Writes a new subscription state and records it in history atomically.
   *
   * Returns the updated row, or **null** when the guards in `options` didn't
   * match — meaning someone else already moved this subscription on and this
   * caller's view of it was stale. A null return is not an error; it's the
   * mechanism that makes every writer idempotent and safe to retry.
   */
  async applyState(
    userId: number,
    next: SubscriptionState,
    options: ApplyStateOptions,
  ): Promise<UserSubscription | null> {
    const handle = options.tx ?? db;
    const run = async (tx: DbHandle): Promise<UserSubscription | null> => {
      const now = new Date();

      const guards = [eq(userSubscriptions.userId, userId)];
      if (options.expectStatus) {
        guards.push(eq(userSubscriptions.status, options.expectStatus));
      }
      if (options.expectNoStripeSubscription) {
        guards.push(isNull(userSubscriptions.stripeSubscriptionId));
      }

      const [updated] = await tx
        .update(userSubscriptions)
        .set({
          tier: next.tier,
          status: next.status,
          ...(next.plan !== undefined && { plan: next.plan }),
          ...(next.priceId !== undefined && { priceId: next.priceId }),
          ...(next.isFoundingMember !== undefined && { isFoundingMember: next.isFoundingMember }),
          ...(next.trialEndsAt !== undefined && { trialEndsAt: next.trialEndsAt }),
          ...(next.trialExpiredAt !== undefined && { trialExpiredAt: next.trialExpiredAt }),
          ...(next.currentPeriodEnd !== undefined && { currentPeriodEnd: next.currentPeriodEnd }),
          ...(next.cancelAtPeriodEnd !== undefined && { cancelAtPeriodEnd: next.cancelAtPeriodEnd }),
          ...(next.stripeCustomerId !== undefined && { stripeCustomerId: next.stripeCustomerId }),
          ...(next.stripeSubscriptionId !== undefined && {
            stripeSubscriptionId: next.stripeSubscriptionId,
          }),
          updatedAt: now,
        })
        .where(and(...guards))
        .returning();

      // Guards didn't match — a concurrent writer got here first. Deliberately
      // not an error: the caller's intent is already satisfied or superseded.
      if (!updated) return null;

      await this.recordHistory(tx, updated, options.reason, options.sourceEventId ?? null, now);
      return updated;
    };

    // Reuse the caller's transaction when there is one; otherwise open our own
    // so the row write and the history write can't come apart.
    return options.tx ? run(handle) : db.transaction(run);
  },

  /**
   * Closes the currently-open history interval and opens a new one for the
   * state the row is now in. A no-op when nothing meaningful changed, so
   * repeated webhook deliveries don't fill the table with identical rows.
   */
  async recordHistory(
    tx: DbHandle,
    row: UserSubscription,
    reason: StateChangeReason,
    sourceEventId: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    const [open] = await tx
      .select()
      .from(subscriptionStateHistory)
      .where(
        and(
          eq(subscriptionStateHistory.userId, row.userId),
          isNull(subscriptionStateHistory.effectiveTo),
        ),
      )
      .limit(1);

    if (open) {
      if (isSameState(open, row)) return;
      await tx
        .update(subscriptionStateHistory)
        .set({ effectiveTo: at })
        .where(eq(subscriptionStateHistory.id, open.id));
    }

    await tx.insert(subscriptionStateHistory).values({
      userId: row.userId,
      tier: row.tier,
      status: row.status,
      plan: row.plan,
      priceId: row.priceId,
      isFoundingMember: row.isFoundingMember,
      trialEndsAt: row.trialEndsAt,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      stripeSubscriptionId: row.stripeSubscriptionId,
      reason,
      sourceEventId,
      effectiveFrom: at,
    });
  },

  /**
   * Expires a trial that has run out.
   *
   * This is the one place that flip is implemented. Both callers — the lazy
   * check in getMe and the hourly sweep — used to do it themselves, with
   * different levels of safety, which is exactly how the race below got in.
   *
   * Two guards make it safe to call from anywhere, at any time:
   *   • status must still be 'trialing' — so two concurrent callers can't both
   *     write the flip and both log an 'expired' event.
   *   • stripe_subscription_id must be null — so a user who paid mid-trial is
   *     never downgraded by a sweep that read their row a moment earlier.
   *
   * Returns the updated row, or null when there was nothing to do.
   */
  async expireTrialIfDue(
    sub: UserSubscription,
    now: Date = new Date(),
  ): Promise<UserSubscription | null> {
    if (sub.status !== 'trialing') return null;
    if (!sub.trialEndsAt || sub.trialEndsAt >= now) return null;

    // Should be impossible: a paid subscriber is moved off 'trialing' by the
    // checkout webhook. If it happens, a webhook was lost or arrived out of
    // order — say so loudly rather than skipping silently, because the daily
    // reconciliation is what needs to repair it.
    if (sub.stripeSubscriptionId) {
      logger.warn('Skipping trial expiry for a subscription that has Stripe billing attached', {
        userId: sub.userId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        trialEndsAt: sub.trialEndsAt,
      });
      return null;
    }

    return db.transaction(async (tx) => {
      const updated = await this.applyState(
        sub.userId,
        {
          tier: 'free',
          status: 'expired',
          trialExpiredAt: now,
        },
        {
          reason: 'trial_expired',
          tx,
          expectStatus: 'trialing',
          expectNoStripeSubscription: true,
        },
      );

      // Lost the race — another caller already expired this trial. Skip the
      // event insert too, so the audit trail keeps one row per real transition.
      if (!updated) return null;

      await tx.insert(subscriptionEvents).values({
        userId: sub.userId,
        event: 'expired',
        previousTrialEndsAt: sub.trialEndsAt,
        newTrialEndsAt: null,
      });

      return updated;
    });
  },

  /** Current subscription row for a user, or null if somehow absent. */
  async get(userId: number): Promise<UserSubscription | null> {
    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .limit(1);
    return sub ?? null;
  },

  /** Looks a subscription up by the Stripe customer it belongs to. */
  async getByStripeCustomerId(customerId: string): Promise<UserSubscription | null> {
    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.stripeCustomerId, customerId))
      .limit(1);
    return sub ?? null;
  },

  /**
   * Reads the row and expires the trial if it's due, returning whichever is
   * current. The standard way to read a subscription on a user-facing path.
   */
  async getCurrent(userId: number): Promise<UserSubscription | null> {
    const sub = await this.get(userId);
    if (!sub) return null;
    return (await this.expireTrialIfDue(sub)) ?? sub;
  },

  /** Effective tier for a user, with the read-time trial fallback applied. */
  async getTier(userId: number): Promise<SubscriptionTier> {
    const sub = await this.get(userId);
    if (!sub) return 'free';
    return getEffectiveTier(sub);
  },

  // ── History ────────────────────────────────────────────────────────────────

  /** Full state history for a user, newest first. */
  async history(userId: number, limit = 100): Promise<SubscriptionStateHistory[]> {
    return db
      .select()
      .from(subscriptionStateHistory)
      .where(eq(subscriptionStateHistory.userId, userId))
      .orderBy(desc(subscriptionStateHistory.effectiveFrom))
      .limit(limit);
  },

  /**
   * What this user's subscription looked like at a point in time. This is the
   * question the history table exists to answer — "were they Plus when they
   * wrote that post", "how many people were paying on 1 March".
   */
  async stateAt(userId: number, at: Date): Promise<SubscriptionStateHistory | null> {
    const [row] = await db
      .select()
      .from(subscriptionStateHistory)
      .where(
        and(
          eq(subscriptionStateHistory.userId, userId),
          lte(subscriptionStateHistory.effectiveFrom, at),
          or(
            isNull(subscriptionStateHistory.effectiveTo),
            gt(subscriptionStateHistory.effectiveTo, at),
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
