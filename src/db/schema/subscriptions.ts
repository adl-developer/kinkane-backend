import {
  pgTable,
  serial,
  integer,
  varchar,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'plus']);

// `past_due` and `incomplete` mirror Stripe states. They exist so a failed
// renewal or an abandoned checkout never silently reads as `active` — a
// past_due subscriber keeps tier=plus through the dunning grace window, but
// the status has to say what's actually going on.
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'trialing',
  'expired',
  'cancelled',
  'past_due',
  'incomplete',
]);

export const subscriptionEventTypeEnum = pgEnum('subscription_event_type', [
  'started',
  'extended',
  'expired',
  'converted',
  'cancelled',
  'renewed',
  'payment_failed',
  'resumed',
  'plan_changed',
  'refunded',
]);

export const subscriptionPlanEnum = pgEnum('subscription_plan', ['monthly', 'annual']);

// ── User Subscriptions ─────────────────────────────────────────────────────────
// One row per user, holding *current* state only. Created synchronously at
// account creation with tier=plus, status=trialing, trial_ends_at=NOW()+90 days.
//
// Three companion tables carry the history this row deliberately doesn't:
//   • subscriptionStateHistory — every state this user has ever been in, with
//     the window each was in force. Answers "what were they on at date X".
//   • subscriptionEvents       — the transitions themselves, with money and
//     admin attribution attached. Answers "what happened, and why".
//   • stripeWebhookEvents      — raw delivery log, for idempotency and replay.
//
// A trialing row whose trial_ends_at has passed is flipped to status=expired,
// tier=free by subscriptionsService.expireTrialIfDue (called lazily from getMe
// and by the hourly trial-expiry cron). That flip deliberately never touches a
// row carrying a stripe_subscription_id — see the note on that column.

export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: subscriptionTierEnum('tier').notNull().default('free'),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    // Set to NOW()+90 days on signup. Kept as a historical fact even after the
    // user converts to paid — it records when the trial would have ended, and
    // nulling it would make the trial-expiry guard depend on data shape rather
    // than on an explicit predicate.
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    // Set once the trial is actually flipped to expired
    trialExpiredAt: timestamp('trial_expired_at', { withTimezone: true }),
    // Which recurring interval they bought. Null while free or trialing.
    plan: subscriptionPlanEnum('plan'),
    // The exact Stripe Price in force. This is what proves a Founding Member is
    // still on their introductory rate — `is_founding_member` alone can't, since
    // it stays true after the schedule rolls them onto standard pricing.
    priceId: varchar('price_id', { length: 256 }),
    isFoundingMember: boolean('is_founding_member').notNull().default(false),
    // End of the paid period Stripe has already collected for. Also the date a
    // cancel_at_period_end subscriber actually loses access.
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    // Set when a Change Plan request has scheduled a switch for the end of the
    // current period (see schedulesService.schedulePlanChange). Null the rest
    // of the time. The effective date is always `currentPeriodEnd` — there is
    // deliberately no separate `pendingPlanEffectiveAt` column to duplicate it.
    pendingPlan: subscriptionPlanEnum('pending_plan'),
    stripeCustomerId: varchar('stripe_customer_id', { length: 256 }),
    // Presence of this column is load-bearing: it is the guard that stops the
    // trial-expiry sweep from downgrading someone who has paid. Never write it
    // speculatively — only from a confirmed Stripe subscription.
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    stripeCustomerIdx: index('idx_user_subscriptions_stripe_customer_id').on(t.stripeCustomerId),
    stripeSubscriptionUniq: uniqueIndex('idx_user_subscriptions_stripe_subscription_id').on(
      t.stripeSubscriptionId,
    ),
  }),
);

// ── Subscription State History ─────────────────────────────────────────────────
// Append-only record of every state a user's subscription has been in, stored
// as validity intervals: each row is in force from `effective_from` until
// `effective_to`, and the single row per user with `effective_to IS NULL` is
// the current state (enforced by a partial unique index).
//
// This is what makes "what tier was this user on last March" answerable, which
// user_subscriptions alone cannot do — it only ever holds now. Every write goes
// through subscriptionsService.applyState, so the current open row is always a
// mirror of user_subscriptions.
//
// Kept separate from subscriptionEvents on purpose: events describe *what
// happened* (a payment failed, an admin extended a trial); this describes *what
// was true*, which is the thing reporting and support questions actually need.

export const subscriptionStateHistory = pgTable(
  'subscription_state_history',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: subscriptionTierEnum('tier').notNull(),
    status: subscriptionStatusEnum('status').notNull(),
    plan: subscriptionPlanEnum('plan'),
    priceId: varchar('price_id', { length: 256 }),
    isFoundingMember: boolean('is_founding_member').notNull().default(false),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    pendingPlan: subscriptionPlanEnum('pending_plan'),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 256 }),
    // Why this state began — 'signup', 'trial_expired', 'checkout_completed',
    // 'invoice_paid', 'subscription_updated', 'subscription_deleted',
    // 'payment_failed', 'admin_extended', 'reconciliation'.
    reason: varchar('reason', { length: 100 }).notNull(),
    // Stripe event id that caused the transition, when one did. Lets a state
    // row be traced back to the exact webhook delivery in stripeWebhookEvents.
    sourceEventId: varchar('source_event_id', { length: 256 }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
    // Null means "still in force". Closed out when the next state is written.
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index('idx_subscription_state_history_user_id').on(t.userId, t.effectiveFrom),
    // At most one open interval per user — the invariant the whole table rests
    // on. A bug that writes a second open row fails loudly here instead of
    // silently making every historical query ambiguous.
    openStateUniq: uniqueIndex('idx_subscription_state_history_open')
      .on(t.userId)
      .where(sql`${t.effectiveTo} is null`),
  }),
);

// ── Subscription Events ────────────────────────────────────────────────────────
// Append-only audit trail of transitions. This is the only place that answers
// "was this trial extended, by whom, and from what value", and — since Stripe
// money fields were added — "what did they actually pay, and when did a payment
// fail".

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: subscriptionEventTypeEnum('event').notNull(),
    previousTrialEndsAt: timestamp('previous_trial_ends_at', { withTimezone: true }),
    newTrialEndsAt: timestamp('new_trial_ends_at', { withTimezone: true }),
    // Set only for admin-triggered events (e.g. 'extended'); null for
    // system-triggered ones (e.g. 'expired' via the cron sweep)
    adminUserId: integer('admin_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: varchar('reason', { length: 500 }),
    // Money, for the events that involve it (renewed, converted, refunded,
    // payment_failed). Stored in minor units exactly as Stripe reports them —
    // never a float.
    amountCents: integer('amount_cents'),
    currency: varchar('currency', { length: 10 }),
    stripeInvoiceId: varchar('stripe_invoice_id', { length: 256 }),
    stripeEventId: varchar('stripe_event_id', { length: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_subscription_events_user_id').on(t.userId),
    createdAtIdx: index('idx_subscription_events_created_at').on(t.createdAt),
  }),
);

// ── Stripe Webhook Events ──────────────────────────────────────────────────────
// Delivery log, keyed by Stripe's own event id. Stripe delivers at-least-once
// and out of order, so the id is claimed here inside the same transaction that
// applies the state change: a duplicate delivery loses the insert race, sees
// the conflict, and skips. `processed_at` staying null on an old row means the
// handler crashed partway — that's the queue of things reconciliation should
// look at.

export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    // Stripe's event id (evt_...) — the natural primary key
    eventId: varchar('event_id', { length: 256 }).primaryKey(),
    type: varchar('type', { length: 100 }).notNull(),
    // Kept for replay and debugging when a handler misbehaves in production.
    payload: jsonb('payload'),
    error: varchar('error', { length: 1000 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    typeIdx: index('idx_stripe_webhook_events_type').on(t.type),
    receivedAtIdx: index('idx_stripe_webhook_events_received_at').on(t.receivedAt),
  }),
);

// ── Tier helper ────────────────────────────────────────────────────────────────

export type SubscriptionTier = 'free' | 'plus';
export type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];
export type SubscriptionPlan = (typeof subscriptionPlanEnum.enumValues)[number];

/**
 * Returns the user's effective subscription tier.
 * Normally status/tier are already flipped to expired/free by the time this
 * runs (see subscriptionsService.expireTrialIfDue). This check is just a
 * fallback for the brief window between trial_ends_at passing and one of those
 * paths actually writing the row.
 */
export function getEffectiveTier(sub: typeof userSubscriptions.$inferSelect): SubscriptionTier {
  if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
    return 'free';
  }
  return sub.tier;
}

export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
export type SubscriptionStateHistory = typeof subscriptionStateHistory.$inferSelect;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
