import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'plus']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'trialing', 'cancelled']);

// ── User Subscriptions ─────────────────────────────────────────────────────────
// One row per user. Created synchronously at account creation with tier=plus,
// status=trialing, trial_ends_at=NOW()+90 days.
// After the trial expires, getEffectiveTier() returns 'free' automatically —
// no cron or DB write needed (Option A: computed at read time).

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
  // Future Stripe integration — nullable until payment is wired up
  stripeCustomerId: varchar('stripe_customer_id', { length: 256 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 256 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Tier helper ────────────────────────────────────────────────────────────────

export type SubscriptionTier = 'free' | 'plus';

/**
 * Returns the user's effective subscription tier.
 * A trialing user whose trial has expired is treated as free without any
 * DB write — the downgrade is purely computed at read time.
 */
export function getEffectiveTier(sub: typeof userSubscriptions.$inferSelect): SubscriptionTier {
  if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
    return 'free';
  }
  return sub.tier;
}

export type UserSubscription = typeof userSubscriptions.$inferSelect;
