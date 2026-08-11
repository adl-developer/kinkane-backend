/**
 * Cart, orders and order lines — the shop.
 *
 * The money model here is the thing to understand before changing anything.
 * Gardners quotes GBP and only GBP; customers are shown and charged in their
 * own currency. So every order carries **both**:
 *
 *  - `*_gbp_pence` — the supplier-side truth. What fulfilment submits to
 *    Gardners and what margin reporting reads. Never converted, never stale.
 *  - `*_minor` + `presentment_currency` — what Stripe actually charged, in that
 *    currency's minor unit.
 *  - `fx_rate` + `fx_captured_at` — pinned at checkout, so the amount displayed
 *    is provably the amount charged and a rate change tomorrow cannot make a
 *    historical order look mispriced.
 *
 * See docs/ecommerce-plan.md for the decisions behind this.
 */
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  varchar,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  text,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { books } from './books';
import { gardnersDropshipOrders } from './gardners-dropship-orders';

export const cartStatusEnum = pgEnum('cart_status', ['active', 'converted', 'abandoned']);

export const orderStatusEnum = pgEnum('order_status', [
  'pending_payment',
  'payment_failed',
  'expired',
  'paid',
  'submitted_to_supplier',
  'acknowledged',
  'supplier_rejected',
  'dispatched',
  'refunded',
  'cancelled',
]);

// ── Carts ─────────────────────────────────────────────────────────────────────

// Deliberately carries no currency column. A cart is a list of intentions, not
// a quotation: currency is resolved from the request every time the cart is
// read, so the same cart shown to the same person after a flight prices
// correctly. Currency first becomes durable data at checkout, on the order.
export const carts = pgTable(
  'carts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: cartStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_carts_user_id').on(t.userId),
    // Exactly one open cart per user, forever. This constraint is what lets
    // "get or create the cart" be a safe upsert instead of a read-then-write
    // race that hands two concurrent add-to-cart taps two different carts.
    oneActivePerUser: uniqueIndex('uq_carts_active_user')
      .on(t.userId)
      .where(sql`status = 'active'`),
  }),
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: serial('id').primaryKey(),
    cartId: integer('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // Denormalised on purpose: the Gardners side is ISBN-keyed, and an ISBN can
    // be re-slipped (see gardners_isbn_slips) after the line was added.
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    quantity: integer('quantity').notNull().default(1),

    // Snapshot of the price when the line was added. NOT what the customer is
    // charged — checkout always re-reads live price and stock. It exists so the
    // cart can *tell the user* their price moved, which is impossible without
    // remembering what it used to be.
    unitPriceGbpPence: integer('unit_price_gbp_pence').notNull(),
    priceCapturedAt: timestamp('price_captured_at', { withTimezone: true }).defaultNow().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cartIdIdx: index('idx_cart_items_cart_id').on(t.cartId),
    // Makes "add the same book again" an increment rather than a duplicate row.
    uniqueCartBook: uniqueIndex('uq_cart_items_cart_book').on(t.cartId, t.bookId),
  }),
);

// ── Orders ────────────────────────────────────────────────────────────────────

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: orderStatusEnum('status').notNull().default('pending_payment'),

    // Supplier side — GBP pence, never converted.
    subtotalGbpPence: integer('subtotal_gbp_pence').notNull(),
    shippingGbpPence: integer('shipping_gbp_pence').notNull().default(0),
    taxGbpPence: integer('tax_gbp_pence').notNull().default(0),
    totalGbpPence: integer('total_gbp_pence').notNull(),

    // Customer side — what Stripe charged.
    presentmentCurrency: varchar('presentment_currency', { length: 3 }).notNull(),
    subtotalMinor: integer('subtotal_minor').notNull(),
    shippingMinor: integer('shipping_minor').notNull().default(0),
    taxMinor: integer('tax_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull(),

    // Provenance. Six months from now, "why was this order charged that?" has
    // to be answerable from the row alone.
    fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).notNull(),
    fxCapturedAt: timestamp('fx_captured_at', { withTimezone: true }).notNull(),
    taxRatePercent: numeric('tax_rate_percent', { precision: 6, scale: 3 }).notNull().default('0'),
    // 'env' today; 'stripe_tax' if that ever replaces the config table.
    taxSource: varchar('tax_source', { length: 20 }).notNull().default('env'),
    // Which SHIPPING_RATES key produced the figure, e.g. 'GB' | 'EU' | 'ROW'.
    shippingRule: varchar('shipping_rule', { length: 20 }),

    stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }).unique(),
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),

    contactEmail: varchar('contact_email', { length: 254 }).notNull(),
    // Collected by Stripe Checkout, written by the webhook. Null until paid.
    shippingName: varchar('shipping_name', { length: 200 }),
    shippingLine1: varchar('shipping_line1', { length: 200 }),
    shippingLine2: varchar('shipping_line2', { length: 200 }),
    shippingCity: varchar('shipping_city', { length: 200 }),
    shippingRegion: varchar('shipping_region', { length: 200 }),
    shippingPostcode: varchar('shipping_postcode', { length: 32 }),
    // ISO-3166 alpha-2. The quoted destination, fixed before payment — the
    // address Stripe collects is verified against it, never silently trusted,
    // because shipping and tax were both priced off this value.
    shippingCountryCode: varchar('shipping_country_code', { length: 2 }).notNull(),

    gardnersDropshipOrderId: integer('gardners_dropship_order_id').references(
      () => gardnersDropshipOrders.id,
      { onDelete: 'set null' },
    ),
    // Why fulfilment could not proceed, when it couldn't. Kept on the order
    // rather than only in logs: this is the text an operator needs to fix it.
    fulfilmentErrorMessage: text('fulfilment_error_message'),

    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_orders_user_id').on(t.userId),
    statusIdx: index('idx_orders_status').on(t.status),
    // Drives both order history and the bestseller window scan.
    createdAtIdx: index('idx_orders_created_at').on(t.createdAt),
  }),
);

export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'restrict' }),
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    quantity: integer('quantity').notNull(),

    unitPriceGbpPence: integer('unit_price_gbp_pence').notNull(),
    lineTotalGbpPence: integer('line_total_gbp_pence').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),

    // Snapshot so a receipt still reads correctly after the catalogue row
    // changes — titles and contributors are re-ingested weekly.
    titleSnapshot: varchar('title_snapshot', { length: 500 }).notNull(),
    contributorSnapshot: varchar('contributor_snapshot', { length: 500 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderIdIdx: index('idx_order_items_order_id').on(t.orderId),
    // The bestseller aggregate: GROUP BY book_id over a created_at window.
    bookIdIdx: index('idx_order_items_book_id').on(t.bookId),
    bestsellerIdx: index('idx_order_items_bestseller').on(t.createdAt, t.bookId),
  }),
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type CartStatus = (typeof cartStatusEnum.enumValues)[number];

/**
 * Statuses that mean the money was taken and the sale stands. The bestseller
 * ranking counts exactly these — a pending_payment order that never completes
 * must never move a book up the chart, and a refund must move it back down.
 */
export const SOLD_ORDER_STATUSES: OrderStatus[] = [
  'paid',
  'submitted_to_supplier',
  'acknowledged',
  'dispatched',
];
