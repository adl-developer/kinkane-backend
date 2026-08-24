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
  // Terminal happy path. Distinct from 'dispatched' because the order UI shows
  // a Delivered bucket, and "left the warehouse" is not "arrived".
  'delivered',
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
    // Always set. A cart only exists once there is an account to hang it on:
    // before sign-in the basket lives entirely on the client, so there is no
    // such thing as an ownerless cart row. See POST /cart/price, which prices a
    // client-held basket without storing anything.
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

    /**
     * The customer-facing order identity, e.g. `ORD-7K2M9QX4`.
     *
     * Deliberately **not** the serial id and deliberately not sequential. A
     * guest can look this order up without an account, so a predictable
     * reference would let anyone walk the order book by incrementing a number.
     * The suffix is crypto-random base32 (Crockford, ambiguous characters
     * removed so it survives being read aloud or retyped from an email).
     *
     * Random alone is not the access control — `guestAccessTokenHash` below is
     * — but it removes enumeration as an attack surface entirely rather than
     * relying on rate limiting to make it merely slow.
     */
    reference: varchar('reference', { length: 32 }).notNull().unique(),

    /**
     * Null for a guest order, set once an account claims it (or from the start
     * for a signed-in buyer). Nullable is what makes guest checkout possible at
     * all; `contactEmail` below is notNull and is the identity that always
     * exists.
     *
     * onDelete stays 'restrict': an order is a financial record and must
     * outlive account deletion. A deleted user's order becomes an unclaimed
     * order, it does not disappear.
     */
    userId: integer('user_id').references(() => users.id, { onDelete: 'restrict' }),

    /**
     * SHA-256 of the one-time token handed to the buyer at checkout. It is the
     * bearer credential behind both "Track My Order" and claiming a guest order
     * into a new account.
     *
     * Hashed for the same reason the cart token is. Cleared when the order is
     * claimed, which makes the claim single-use: a token leaked from a browser
     * history or a shared email cannot re-attach an already-owned order to
     * somebody else's account.
     */
    guestAccessTokenHash: varchar('guest_access_token_hash', { length: 64 }),

    /**
     * The cart this order was created from.
     *
     * Recorded so the paid-webhook converts *this* cart rather than "whatever
     * cart that user has open now" — which was only ever correct because a
     * user had exactly one. A guest cart has no user to look it up by, and a
     * buyer who starts a second basket while a payment is pending would
     * otherwise have the wrong one converted out from under them.
     */
    cartId: integer('cart_id').references(() => carts.id, { onDelete: 'set null' }),

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
    // The same address with `+tags` and (at the providers that ignore them)
    // dots removed — see lib/email-identity. Stored rather than computed at
    // query time so the first-order-discount check is one indexed lookup
    // instead of a scan with a function on every row. Promotions only: it is a
    // guess about mailbox aliasing and must never be treated as an identity.
    contactEmailNormalized: varchar('contact_email_normalized', { length: 254 }).notNull(),
    // Promotional discount applied at checkout, both currency sides like every
    // other money column here. Zero when none applied — nullable would mean two
    // ways to say "no discount" and a null check on every sum.
    discountGbpPence: integer('discount_gbp_pence').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    // Why it was given, e.g. 'first_order'. Null when there was none. A string
    // rather than a boolean so a second promotion is a new value rather than a
    // new column — and so the reports screen can group by it.
    discountReason: varchar('discount_reason', { length: 40 }),
    // E.164 delivery contact, or null. Snapshotted onto the order rather than
    // read from the user at fulfilment time: a buyer who later edits their
    // profile number must not retroactively change where a courier calls about
    // a parcel that already shipped. Optional because the older checkout flow,
    // where Stripe collects the address, never asks for one.
    contactPhone: varchar('contact_phone', { length: 32 }),
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

    // ── Shipment tracking ────────────────────────────────────────────────────
    // Populated by fulfilment once Gardners reports a dispatch. All nullable:
    // an order is legitimately trackable-less until it physically ships, and a
    // supplier that never sends a tracking number is a normal case, not an
    // error state.
    carrier: varchar('carrier', { length: 100 }),
    trackingNumber: varchar('tracking_number', { length: 100 }),
    // Stored rather than templated per carrier so a carrier we have no URL
    // pattern for still shows a number, and so a pattern change is data, not a
    // deploy. Rendered as a link, so it must be validated on write.
    trackingUrl: varchar('tracking_url', { length: 500 }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_orders_user_id').on(t.userId),
    // Backs the first-order-discount eligibility check, which runs on every
    // checkout and asks whether this mailbox has ever paid for anything.
    contactEmailNormalizedIdx: index('idx_orders_contact_email_normalized').on(
      t.contactEmailNormalized,
    ),
    // **The first-order discount, enforced by the database rather than by a
    // check in application code.**
    //
    // The eligibility query alone is check-then-act: two checkouts started at
    // the same moment both see no paid order, both get the discount, and both
    // can then be paid. No amount of care in the service closes that window —
    // only a constraint the database evaluates at write time does.
    //
    // Partial on purpose. Orders that were never going to be paid are excluded,
    // so abandoning a discounted checkout and starting another one still works:
    // the abandoned row leaves the index the moment it expires or fails. What
    // it forbids is *two live discounted orders for one mailbox at once*.
    oneLiveFirstOrderDiscount: uniqueIndex('uq_orders_first_order_discount')
      .on(t.contactEmailNormalized)
      .where(
        sql`${t.discountReason} = 'first_order' AND ${t.status} NOT IN ('expired', 'payment_failed', 'cancelled')`,
      ),
    statusIdx: index('idx_orders_status').on(t.status),
    // Drives both order history and the bestseller window scan.
    createdAtIdx: index('idx_orders_created_at').on(t.createdAt),
    // Guest order lookup is by reference; the unique constraint on the column
    // already indexes it, so nothing extra is needed here.
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
