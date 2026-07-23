import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'plus']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'trialing', 'expired', 'cancelled']);
export const subscriptionEventTypeEnum = pgEnum('subscription_event_type', [
  'started',
  'extended',
  'expired',
  'converted',
  'cancelled',
]);

// ── User Subscriptions ─────────────────────────────────────────────────────────
// One row per user. Created synchronously at account creation with tier=plus,
// status=trialing, trial_ends_at=NOW()+90 days.
// A trialing row whose trial_ends_at has passed is flipped to status=expired,
// tier=free (see auth.service.ts's getMe for the read-time check, and
// trial-expiry.cron.ts for the periodic sweep that catches dormant accounts).
// Every state change of note (started/extended/expired/converted/cancelled) is
// also recorded in subscriptionEvents below so it can be audited later.

export const userSubscriptions = pgTable('user_subscriptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  tier: subscriptionTierEnum('tier').notNull().default('free'),
  status: subscriptionStatusEnum('status').notNull().default('active'),
  // Set to NOW()+90 days on signup; null once a user is on a paid or permanent plan
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  // Set once the trial is actually flipped to expired (read-time check or cron sweep)
  trialExpiredAt: timestamp('trial_expired_at', { withTimezone: true }),
  // Future Stripe integration — nullable until payment is wired up
  stripeCustomerId: varchar('stripe_customer_id', { length: 256 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 256 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Subscription Events ────────────────────────────────────────────────────────
// Append-only audit trail for the trial/subscription lifecycle. This is the
// only place that answers "was this trial extended, by whom, and from what
// value" — user_subscriptions itself only ever holds the current state.

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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_subscription_events_user_id').on(t.userId),
  }),
);

// ── Tier helper ────────────────────────────────────────────────────────────────

export type SubscriptionTier = 'free' | 'plus';

/**
 * Returns the user's effective subscription tier.
 * Normally status/tier are already flipped to expired/free by the time this
 * runs (see auth.service.ts's getMe and trial-expiry.cron.ts). This check is
 * just a fallback for the brief window between trial_ends_at passing and one
 * of those two paths actually writing the row.
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
