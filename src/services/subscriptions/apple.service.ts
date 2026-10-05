import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, subscriptionEvents, appleNotificationEvents } from '../../db/schema';
import { getBillingProvider } from '../../db/schema';
import type { UserSubscription, NewSubscriptionEvent } from '../../db/schema';
import { config } from '../../config';
import {
  appleStore,
  appAccountTokenFor,
  decodeJws,
  mapAppleStatus,
  planForAppleProduct,
  type AppleNotificationPayload,
  type AppleSubscriptionSnapshot,
  type AppleTransaction,
} from '../../lib/apple-store';
import { logger } from '../../lib/logger';
import { reclaimableClaim } from '../../lib/delivery-claim';
import { enqueueEmail } from '../../lib/email-queue';
import { subscriptionStateService, type StateChangeReason } from './state.service';
import { entitlementsService } from './entitlements.service';

/**
 * Kinkané Plus bought through the App Store.
 *
 * Mirrors webhooks.service.ts for Stripe, with the same three rules:
 *
 *  1. **Idempotent.** Notifications are claimed by notificationUUID before
 *     they're handled; a redelivery is skipped.
 *  2. **Order-independent.** Nothing here applies a delta. Every path — the
 *     verify call, a notification, the daily reconciliation — re-reads the
 *     subscription from Apple and writes the state Apple reports now.
 *  3. **Never guess whose subscription this is.** A chain is bound to a user
 *     only by the verify endpoint, which is authenticated. A notification for
 *     a chain nobody has verified yet is skipped; the app's
 *     verify call (which StoreKit keeps retrying until it succeeds) binds it.
 */

interface SyncContext {
  reason: StateChangeReason;
  /** Set by the verify endpoint: the signed-in user claiming this purchase. */
  claimingUserId?: number;
  notification?: AppleNotificationPayload;
}

type SyncOutcome =
  | { kind: 'applied'; subscription: UserSubscription }
  | { kind: 'unchanged'; subscription: UserSubscription | null; why: string };

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** An entitled Stripe subscription — the one thing an Apple write must never overwrite. */
function hasLiveStripe(sub: UserSubscription | null): boolean {
  return Boolean(
    sub &&
      getBillingProvider(sub) === 'stripe' &&
      sub.stripeSubscriptionId &&
      sub.tier === 'plus' &&
      (sub.status === 'active' || sub.status === 'past_due'),
  );
}

/** Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/** Apple reports price in milliunits (8990 = 8.99); we store minor units. */
function amountCents(t: AppleTransaction): number | null {
  return typeof t.price === 'number' ? Math.round(t.price / 10) : null;
}

/**
 * The audit event a notification type stands for, beyond the ones derived
 * from the state change itself (converted, cancelled, resumed, plan_changed).
 */
function eventForNotification(
  n: AppleNotificationPayload,
  t: AppleTransaction,
): Pick<NewSubscriptionEvent, 'event' | 'reason' | 'amountCents' | 'currency'> | null {
  switch (n.notificationType) {
    case 'DID_RENEW':
      return {
        event: 'renewed',
        amountCents: amountCents(t),
        currency: t.currency ?? null,
        reason: n.subtype === 'BILLING_RECOVERY' ? 'Renewed after a failed payment' : null,
      };
    case 'DID_FAIL_TO_RENEW':
      return {
        event: 'payment_failed',
        reason: n.subtype === 'GRACE_PERIOD' ? 'App Store renewal failed — in grace period' : 'App Store renewal failed',
      };
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
      return { event: 'expired', reason: `App Store subscription expired (${n.subtype ?? n.notificationType})` };
    case 'REFUND':
      return {
        event: 'refunded',
        amountCents: amountCents(t),
        currency: t.currency ?? null,
        reason: 'Refunded by Apple',
      };
    case 'REVOKE':
      return { event: 'cancelled', reason: 'Family Sharing access revoked' };
    default:
      return null;
  }
}

export const appleSubscriptionsService = {
  /**
   * POST /user/subscription/apple/verify — the app has just completed (or
   * restored) a purchase and hands us its transaction id. Asks Apple for the
   * subscription, binds it to this user, and switches Plus on.
   *
   * Safe to call repeatedly with the same transaction: the second call finds
   * nothing changed. Returns the user's subscription row afterwards.
   */
  async verifyPurchase(userId: number, transactionId: string): Promise<UserSubscription> {
    const snapshot = await appleStore.getSubscription(transactionId);
    if (!snapshot) {
      throw httpError(
        'That purchase could not be found with the App Store',
        404,
        'APPLE_TRANSACTION_NOT_FOUND',
      );
    }

    const outcome = await this.sync(snapshot, { reason: 'apple_verified', claimingUserId: userId });
    if (outcome.kind === 'applied') return outcome.subscription;

    const current = outcome.subscription ?? (await subscriptionStateService.getCurrent(userId));
    if (!current) throw httpError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
    return current;
  },

  /**
   * POST /user/subscription/apple/notifications — App Store Server
   * Notifications V2. Returns normally for anything Apple shouldn't retry,
   * including events we chose to ignore; throws only for a malformed body.
   */
  async handleNotification(signedPayload: string): Promise<{ duplicate: boolean }> {
    const notification = decodeJws<AppleNotificationPayload>(signedPayload);
    const type = notification.subtype
      ? `${notification.notificationType}/${notification.subtype}`
      : notification.notificationType;

    if (!notification.notificationUUID || !notification.notificationType) {
      throw httpError('Not an App Store notification', 400, 'INVALID_NOTIFICATION');
    }

    if (notification.data?.bundleId && notification.data.bundleId !== config.apple.bundleId) {
      logger.warn('Ignoring App Store notification for another app', {
        notificationId: notification.notificationUUID,
        bundleId: notification.data.bundleId,
      });
      return { duplicate: false };
    }

    if (notification.notificationType === 'TEST') {
      logger.info('App Store test notification received', { notificationId: notification.notificationUUID });
      return { duplicate: false };
    }

    const transaction = notification.data?.signedTransactionInfo
      ? decodeJws<AppleTransaction>(notification.data.signedTransactionInfo)
      : null;

    if (!transaction?.originalTransactionId || !transaction.transactionId) {
      logger.info('App Store notification carries no transaction — nothing to sync', { type });
      return { duplicate: false };
    }

    if (notification.data?.environment === 'Sandbox' && !config.apple.allowSandbox) {
      logger.info('Ignoring sandbox App Store notification', { type });
      return { duplicate: false };
    }

    // Only a chain some account has verified is worth asking Apple about —
    // nobody else's state could change. Checked before anything is written or
    // fetched, so a stream of forged notifications costs one indexed read
    // each, rather than a log row and a call on our App Store API quota. It is
    // also the common case for SUBSCRIBED, which usually beats the app's
    // verify call; verify reads the full state anyway.
    const bound = await subscriptionStateService.getByAppleOriginalTransactionId(
      transaction.originalTransactionId,
    );
    if (!bound) {
      logger.info('App Store subscription not linked to an account yet — skipping', {
        type,
        originalTransactionId: transaction.originalTransactionId,
      });
      return { duplicate: false };
    }

    const claimed = await db
      .insert(appleNotificationEvents)
      .values({
        notificationId: notification.notificationUUID,
        type,
        originalTransactionId: transaction.originalTransactionId,
        environment: notification.data?.environment ?? null,
        payload: { ...notification, transaction } as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: appleNotificationEvents.notificationId,
        set: { receivedAt: sql`now()` },
        setWhere: reclaimableClaim(appleNotificationEvents.processedAt, appleNotificationEvents.receivedAt),
      })
      .returning({ id: appleNotificationEvents.notificationId });

    if (claimed.length === 0) return { duplicate: true };

    try {
      // The notification only tells us which subscription to look at. What
      // it says happened is re-read from Apple, never taken from the body.
      const snapshot = await appleStore.getSubscription(transaction.transactionId);
      if (snapshot) {
        await this.sync(snapshot, { reason: 'apple_notification', notification });
      } else {
        logger.warn('App Store notification for a transaction Apple does not recognise as Plus', {
          type,
          transactionId: transaction.transactionId,
        });
      }
      await this.markNotification(notification.notificationUUID, { processed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = ((err as { statusCode?: number }).statusCode ?? 0) >= 500;
      logger.error('App Store notification handler failed', {
        notificationId: notification.notificationUUID,
        type,
        error: message,
        willRetry: transient,
      });

      if (transient) {
        // Apple was unreachable or refused our key. Leave the claim open and
        // answer non-2xx, so Apple redelivers (1h, 12h, 24h, 48h, 72h) and the
        // stale claim is taken again. Answering 200 here would lose it for
        // good: reconciliation never looks at ended subscriptions, so a
        // resubscribe made in iPhone Settings would never reach us.
        await this.markNotification(notification.notificationUUID, { processed: false, error: message });
        throw httpError('App Store unavailable — retry later', 503, 'APPLE_IAP_UPSTREAM');
      }

      // A bug, not an outage: a redelivery would fail the same way. Record it
      // and answer 200, as the Stripe webhook does.
      await this.markNotification(notification.notificationUUID, { processed: true, error: message });
    }

    return { duplicate: false };
  },

  async markNotification(
    notificationId: string,
    outcome: { processed: boolean; error?: string },
  ): Promise<void> {
    await db
      .update(appleNotificationEvents)
      .set({
        ...(outcome.processed && { processedAt: new Date() }),
        ...(outcome.error && { error: outcome.error.slice(0, 1000) }),
      })
      .where(eq(appleNotificationEvents.notificationId, notificationId));
  },

  /**
   * Re-reads one bound subscription from Apple and repairs any drift. Used by
   * the daily reconciliation; returns whether anything changed.
   */
  async reconcile(sub: UserSubscription): Promise<boolean> {
    if (!sub.appleOriginalTransactionId) return false;
    const snapshot = await appleStore.getSubscription(sub.appleOriginalTransactionId);
    if (!snapshot) return false;
    const outcome = await this.sync(snapshot, { reason: 'reconciliation' });
    return outcome.kind === 'applied';
  },

  /**
   * Writes the state Apple reports for one subscription chain onto the user it
   * belongs to. The one place an Apple subscription becomes our state.
   */
  async sync(snapshot: AppleSubscriptionSnapshot, ctx: SyncContext): Promise<SyncOutcome> {
    const { transaction, renewal } = snapshot;
    const originalTransactionId = transaction.originalTransactionId;
    const bound = await subscriptionStateService.getByAppleOriginalTransactionId(originalTransactionId);

    // ── Whose is it? ──
    let userId: number;
    if (ctx.claimingUserId !== undefined) {
      userId = ctx.claimingUserId;
      if (bound && bound.userId !== userId) {
        // One App Store subscription, one Kinkané account. Without this a
        // single purchase could be "restored" onto any number of accounts.
        throw httpError(
          'This App Store subscription is already linked to a different Kinkané account',
          409,
          'APPLE_SUBSCRIPTION_IN_USE',
        );
      }
      if (
        transaction.appAccountToken &&
        transaction.appAccountToken.toLowerCase() !== appAccountTokenFor(userId)
      ) {
        throw httpError(
          'This purchase was made while signed in to a different Kinkané account',
          409,
          'APPLE_ACCOUNT_MISMATCH',
        );
      }
    } else if (bound) {
      userId = bound.userId;
    } else {
      // Common and harmless: SUBSCRIBED often lands before the app's verify call.
      logger.info('App Store subscription not linked to an account yet — skipping', {
        originalTransactionId,
        reason: ctx.reason,
        type: ctx.notification?.notificationType,
      });
      return { kind: 'unchanged', subscription: null, why: 'unbound' };
    }

    const existing = bound?.userId === userId ? bound : await subscriptionStateService.get(userId);
    const { status, tier } = mapAppleStatus(snapshot.status, transaction);
    const entitled = tier === 'plus';

    // ── Is Apple allowed to write this row? ──
    if (hasLiveStripe(existing)) {
      // Paying twice. The app should never offer an App Store purchase to a
      // Stripe subscriber (it reads `provider`), so this needs a human: the
      // user is owed a refund from Apple. Leave the Stripe state alone.
      logger.error('App Store purchase for a user who already pays through Stripe', {
        userId,
        originalTransactionId,
        stripeSubscriptionId: existing?.stripeSubscriptionId,
        appleStatus: snapshot.status,
      });
      if (ctx.claimingUserId !== undefined && entitled) {
        throw httpError(
          'You already have Kinkané Plus through the website',
          409,
          'STRIPE_SUBSCRIPTION_ACTIVE',
        );
      }
      return { kind: 'unchanged', subscription: existing, why: 'stripe_owns_row' };
    }

    if (!entitled && existing?.appleOriginalTransactionId !== originalTransactionId) {
      // A lapsed chain only ever updates the row it is already bound to.
      // Otherwise restoring an old, expired purchase would end a running
      // trial, or knock out the live chain from a newer Apple ID.
      if (ctx.claimingUserId !== undefined) {
        throw httpError(
          'That App Store subscription is no longer active',
          409,
          'APPLE_SUBSCRIPTION_INACTIVE',
        );
      }
      return { kind: 'unchanged', subscription: existing, why: 'inactive_unbound_chain' };
    }

    // ── What is it now? ──
    const plan = planForAppleProduct(transaction.productId);
    const renewsTo = planForAppleProduct(renewal?.autoRenewProductId);
    const willRenew = renewal?.autoRenewStatus !== 0;
    const cancelAtPeriodEnd = entitled && !willRenew;
    const pendingPlan = entitled && willRenew && renewsTo && renewsTo !== plan ? renewsTo : null;
    const currentPeriodEnd = transaction.expiresDate ? new Date(transaction.expiresDate) : null;

    // A conversion is this chain starting, or starting again after it ended.
    // Keyed on status rather than tier: a subscription in billing retry is
    // still running (past_due, tier free), and its recovery is a renewal —
    // not a new conversion with a second welcome email.
    const wasRunningHere =
      existing?.billingProvider === 'apple' &&
      existing.appleOriginalTransactionId === originalTransactionId &&
      existing.status !== 'cancelled' &&
      existing.status !== 'expired';
    const converted = entitled && !wasRunningHere;
    const startedCancelling = !converted && cancelAtPeriodEnd && !existing?.cancelAtPeriodEnd;
    const resumed = !converted && entitled && !cancelAtPeriodEnd && !!existing?.cancelAtPeriodEnd;
    const planChanged = !converted && Boolean(existing?.plan && plan && existing.plan !== plan);
    const notificationEvent = ctx.notification
      ? eventForNotification(ctx.notification, transaction)
      : null;

    let updated: UserSubscription | null;
    try {
      updated = await subscriptionStateService.applyState(
        userId,
        {
          tier,
          status,
          plan,
          priceId: transaction.productId,
          currentPeriodEnd,
          cancelAtPeriodEnd,
          pendingPlan,
          // Founding pricing is a Stripe price; nothing on the App Store grants
          // it yet. A former Stripe founding member keeps the flag otherwise.
          isFoundingMember: false,
          billingProvider: 'apple',
          appleOriginalTransactionId: originalTransactionId,
          appleEnvironment: snapshot.environment,
          // Stripe fields and trial_ends_at are deliberately left alone: the
          // former are another provider's history, the latter the in-app trial's.
        },
        {
          reason: ctx.reason,
          sourceEventId: ctx.notification?.notificationUUID ?? null,
          inSameTx: async (tx) => {
            const base = {
              userId,
              appleTransactionId: transaction.transactionId,
              appleNotificationId: ctx.notification?.notificationUUID ?? null,
            };
            const rows: NewSubscriptionEvent[] = [];
            if (converted) {
              rows.push({
                ...base,
                event: 'converted',
                amountCents: amountCents(transaction),
                currency: transaction.currency ?? null,
                reason: 'App Store purchase',
              });
            } else if (notificationEvent) {
              rows.push({ ...base, ...notificationEvent });
            }
            if (planChanged) {
              rows.push({ ...base, event: 'plan_changed', reason: `App Store plan changed from ${existing?.plan} to ${plan}` });
            }
            if (startedCancelling) {
              rows.push({ ...base, event: 'cancelled', reason: 'Auto-renew turned off in the App Store' });
            }
            if (resumed) {
              rows.push({ ...base, event: 'resumed', reason: 'Auto-renew turned back on in the App Store' });
            }
            if (rows.length) await tx.insert(subscriptionEvents).values(rows);
          },
        },
      );
    } catch (err) {
      // Two accounts verifying the same unlinked chain at the same moment both
      // pass the `bound` check above; the unique index lets only one link it.
      if (isUniqueViolation(err)) {
        throw httpError(
          'This App Store subscription is already linked to a different Kinkané account',
          409,
          'APPLE_SUBSCRIPTION_IN_USE',
        );
      }
      throw err;
    }

    if (!updated) {
      logger.error('App Store sync could not update the subscription row', { userId, originalTransactionId });
      return { kind: 'unchanged', subscription: existing, why: 'write_failed' };
    }

    await entitlementsService.invalidate(userId);

    if (converted || startedCancelling) {
      await this.sendEmail(userId, converted ? 'confirmed' : 'cancelled', updated);
    }

    logger.info('App Store subscription synced', {
      userId,
      originalTransactionId,
      status,
      tier,
      plan,
      reason: ctx.reason,
      type: ctx.notification?.notificationType,
    });

    return { kind: 'applied', subscription: updated };
  },

  /**
   * Same emails Stripe subscribers get. Outside the transaction, as in
   * webhooks.service: a Redis blip must not roll back a state change.
   */
  async sendEmail(
    userId: number,
    kind: 'confirmed' | 'cancelled',
    sub: UserSubscription,
  ): Promise<void> {
    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return;

    const job =
      kind === 'confirmed'
        ? enqueueEmail('subscription-confirmed', {
            to: user.email,
            name: user.name,
            plan: sub.plan ?? 'monthly',
            isFounding: false,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          })
        : enqueueEmail('subscription-cancelled', {
            to: user.email,
            name: user.name,
            accessEndsAt: sub.currentPeriodEnd?.toISOString() ?? null,
          });

    await job.catch((err) => {
      logger.error(`Failed to enqueue App Store subscription ${kind} email`, {
        userId,
        error: (err as Error).message,
      });
    });
  },
};
