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

// ── Payments ───────────────────────────────────────────────────────────────────
// One row per Stripe Checkout Session this server creates, for *any* kind of
// payment — a Kinkané Plus subscription or a book order.
//
// It exists to give the mobile app one thing to hold on to. The two checkout
// flows otherwise hand the client different identifiers (a `cs_…` session id for
// subscriptions, our own integer order id for books), and neither is something a
// client should be reasoning about. Instead both flows mint a `reference` here
// and return it alongside the Stripe URL; the app stores that one string and
// later exchanges it for a status.
//
// This is deliberately NOT the billing source of truth. Stripe is, and
// `user_subscriptions` / `orders` remain the records the rest of the system acts
// on. This table is a confirmation surface: it answers "did the payment the user
// just attempted go through", which is a question neither of those tables can
// answer by a single client-held key.

export const paymentKindEnum = pgEnum('payment_kind', ['subscription', 'order']);

export const paymentStatusEnum = pgEnum('payment_status', [
  // Session created, nothing has come back yet. Every row starts here.
  'pending',
  'succeeded',
  'failed',
  // The Checkout Session passed its 24-hour expiry without being paid.
  'expired',
  // The user backed out of the Stripe-hosted page.
  'cancelled',
]);

export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    // The client-held key. Ours, not Stripe's — deliberately, so the app never
    // has to know which payment flow it went through, and so the identifier it
    // stores stays stable even if the underlying Stripe object changes shape.
    reference: varchar('reference', { length: 32 }).notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: paymentKindEnum('kind').notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    // Unique: one payment row per Checkout Session, so a retried create can't
    // silently produce two references for the same actual payment.
    stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }).notNull().unique(),
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
    // Set only for kind='order'. Intentionally a plain integer with no foreign
    // key to `orders`: this table must be creatable and migratable without
    // depending on the commerce schema landing first, and a payment record
    // should outlive the order it paid for rather than cascade away with it.
    orderId: integer('order_id'),
    amountCents: integer('amount_cents'),
    currency: varchar('currency', { length: 3 }),
    // Why a payment ended up failed/expired/cancelled, in Stripe's words where
    // it gives them. Shown to support, never to the payer.
    failureReason: varchar('failure_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // When the status last moved off 'pending'.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // When we last asked Stripe directly. Used to rate-limit the read-through
    // fallback so a client polling in a tight loop can't turn one screen into a
    // Stripe API flood.
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  },
  (t) => ({
    // The confirm endpoint always reads by (reference, user) — ownership is part
    // of the lookup rather than a check afterwards, so a reference belonging to
    // someone else is indistinguishable from one that doesn't exist.
    userIdx: index('idx_payments_user_id').on(t.userId, t.createdAt),
    statusIdx: index('idx_payments_status').on(t.status),
  }),
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentKind = (typeof paymentKindEnum.enumValues)[number];
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
