/**
 * Gardners Books "I12 Home Delivery" (dropship) ordering — the B2B purchase
 * flow used to fulfill an end-customer order by having Gardners ship
 * directly to them. Separate from the read-only catalogue/stock feeds in
 * gardners-stock.ts etc.: this is a bidirectional flow (we submit an .ORD
 * file, Gardners returns an .ACK) against a dedicated Home Delivery FTP
 * account. See EDI_docs/I12 FTP Home Delivery Specification.pdf.
 *
 * The order line's own serial `id`, zero-padded to 9 digits, IS the EDI
 * "UNIQUE REFERENCE" field — it's globally unique and monotonically
 * increasing for the lifetime of the table, exactly what the spec requires,
 * with no separate counter to maintain.
 */
import { pgTable, pgEnum, serial, integer, varchar, text, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const gardnersDropshipOrderStatusEnum = pgEnum('gardners_dropship_order_status', [
  'pending_submission',
  'submitted',
  'acknowledged',
  'rejected',
  'submission_failed',
]);

export const gardnersDropshipLineStatusEnum = pgEnum('gardners_dropship_line_status', [
  'pending',
  'fulfilled',
  'partial',
  'backordered',
  'rejected',
]);

// One row per .ORD file submitted to HOMEORD. fileStem doubles as both the
// filename (`${fileStem}.ORD`) and the HEADER SEQUENCE field — a hex
// timestamp is unique, monotonically increasing, and satisfies the spec's
// "numeric order number, hex allowed" requirement without needing a shared
// counter across processes.
export const gardnersDropshipOrders = pgTable(
  'gardners_dropship_orders',
  {
    id: serial('id').primaryKey(),
    fileStem: varchar('file_stem', { length: 15 }).notNull().unique(),
    accountCode: varchar('account_code', { length: 6 }).notNull(),
    // Y in the HEADER TESTING flag — Gardners parses and acknowledges the
    // file normally but never actually creates the order lines. Always
    // default new code paths to true; flipping to false is a deliberate,
    // explicit choice per order.
    testing: boolean('testing').notNull().default(true),
    orderDate: date('order_date').notNull(),
    status: gardnersDropshipOrderStatusEnum('status').notNull().default('pending_submission'),

    remoteOrdPath: varchar('remote_ord_path', { length: 500 }),
    remoteAckPath: varchar('remote_ack_path', { length: 500 }),
    rawAck: text('raw_ack'),
    // Set only when the whole file was rejected (bad HEADER/TRAILER, or a
    // duplicate SEQUENCE) — none of the DETAIL lines were processed at all.
    headerErrorMessage: text('header_error_message'),

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('idx_gardners_dropship_orders_status').on(t.status),
  }),
);

// One row per DETAIL line (one book) within an order. Carries a full
// snapshot of the home-delivery fields as actually submitted, so the .ORD
// file can be rebuilt/audited later without depending on mutable book/price
// data. Address fields are duplicated per-line (not hoisted to the order)
// because the EDI spec itself scopes them per-DETAIL — a single order file
// could in principle ship to different addresses on different lines.
export const gardnersDropshipOrderLines = pgTable(
  'gardners_dropship_order_lines',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id')
      .notNull()
      .references(() => gardnersDropshipOrders.id, { onDelete: 'cascade' }),

    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    additionalReference: varchar('additional_reference', { length: 15 }).notNull(),
    quantity: integer('quantity').notNull(),

    // Pence, matching the EDI wire format (e.g. 1499 for £14.99).
    priceGbpPence: integer('price_gbp_pence').notNull(),
    deliveryGbpPence: integer('delivery_gbp_pence').notNull().default(0),
    serviceCode: varchar('service_code', { length: 3 }).notNull(),
    tracking: boolean('tracking').notNull().default(true),
    trackingEmail: varchar('tracking_email', { length: 254 }).notNull(),
    trackingSms: varchar('tracking_sms', { length: 20 }),
    trackingSafePlace: varchar('tracking_safe_place', { length: 24 }),
    batchRef: varchar('batch_ref', { length: 15 }),
    maxWaitDays: integer('max_wait_days').notNull().default(7),
    comm1: varchar('comm1', { length: 60 }),

    invoiceTitleName: varchar('invoice_title_name', { length: 10 }),
    invoiceInitials: varchar('invoice_initials', { length: 3 }),
    invoiceName: varchar('invoice_name', { length: 35 }).notNull(),
    invoiceAddr1: varchar('invoice_addr1', { length: 35 }).notNull(),
    invoiceAddr2: varchar('invoice_addr2', { length: 35 }),
    invoiceAddr3: varchar('invoice_addr3', { length: 35 }),
    invoiceAddr4: varchar('invoice_addr4', { length: 35 }),
    invoicePostcode: varchar('invoice_postcode', { length: 8 }),
    invoiceCountry: varchar('invoice_country', { length: 60 }).notNull(),

    // Null delivery* fields => Gardners uses the invoice address (spec
    // behavior when DADDR1 is blank).
    deliveryTitleName: varchar('delivery_title_name', { length: 10 }),
    deliveryInitials: varchar('delivery_initials', { length: 3 }),
    deliveryName: varchar('delivery_name', { length: 35 }),
    deliveryAddr1: varchar('delivery_addr1', { length: 35 }),
    deliveryAddr2: varchar('delivery_addr2', { length: 35 }),
    deliveryAddr3: varchar('delivery_addr3', { length: 35 }),
    deliveryAddr4: varchar('delivery_addr4', { length: 35 }),
    deliveryPostcode: varchar('delivery_postcode', { length: 8 }),
    deliveryCountry: varchar('delivery_country', { length: 60 }),

    status: gardnersDropshipLineStatusEnum('status').notNull().default('pending'),
    gardnersRef: varchar('gardners_ref', { length: 20 }),
    quantitySupplied: integer('quantity_supplied'),
    reportCode: varchar('report_code', { length: 10 }),
    reportDate: date('report_date'),
    lineErrorMessage: text('line_error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderIdIdx: index('idx_gardners_dropship_order_lines_order_id').on(t.orderId),
    isbnIdx: index('idx_gardners_dropship_order_lines_isbn13').on(t.isbn13),
  }),
);

export type GardnersDropshipOrder = typeof gardnersDropshipOrders.$inferSelect;
export type NewGardnersDropshipOrder = typeof gardnersDropshipOrders.$inferInsert;
export type GardnersDropshipOrderLine = typeof gardnersDropshipOrderLines.$inferSelect;
export type NewGardnersDropshipOrderLine = typeof gardnersDropshipOrderLines.$inferInsert;

/**
 * One row per DETAIL record in a `.HDD` dispatch file — that is, one row per
 * *item actually shipped*, not per order.
 *
 * A separate table rather than columns on the order line, because the I12
 * specification makes clear that dispatch is many-to-one with an order line:
 * "where multiple copies are ordered and the Wait Time specified when ordering
 * has been exceeded ... the one title may be shipped on multiple dispatches."
 * Folding the newest dispatch onto the line would silently discard the earlier
 * shipment, tracking number and all.
 *
 * `rawDetail` keeps the DETAIL1-4 prose verbatim. Carrier, tracking number and
 * tracking URL are all recovered from that free text by hdd-parser, so when the
 * extraction misses a phrasing an operator needs to see what was actually sent
 * rather than the parser's opinion of it.
 */
export const gardnersDropshipDispatches = pgTable(
  'gardners_dropship_dispatches',
  {
    id: serial('id').primaryKey(),
    orderLineId: integer('order_line_id')
      .notNull()
      .references(() => gardnersDropshipOrderLines.id, { onDelete: 'cascade' }),

    // Gardners' own dispatch number. Everything shipped in one parcel shares
    // it, so it is what groups these rows into physical shipments.
    dispatchNo: varchar('dispatch_no', { length: 20 }).notNull(),

    // The ISBN Gardners actually supplied, which may differ from the one
    // ordered — an out-of-print title can be slipped to a new edition. Stored
    // so a substitution is visible instead of inferred.
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    quantity: integer('quantity').notNull(),
    dispatchedOn: date('dispatched_on'),

    // What Gardners charged *us*. Not what the customer paid — that is on the
    // order — but needed to reconcile the supplier invoice.
    pricePence: integer('price_pence'),
    deliveryPence: integer('delivery_pence'),
    discountBasisPoints: integer('discount_basis_points'),

    carrier: varchar('carrier', { length: 100 }),
    trackingNumber: varchar('tracking_number', { length: 100 }),
    trackingUrl: varchar('tracking_url', { length: 500 }),

    /** DETAIL1-4 verbatim, newline-joined. The audit trail behind the three fields above. */
    rawDetail: text('raw_detail'),
    /** The `.HDD` file this came from, for tracing a bad row back to its source. */
    sourceFile: varchar('source_file', { length: 100 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderLineIdIdx: index('idx_gardners_dropship_dispatches_line').on(t.orderLineId),
    // **The idempotency guarantee.** HDD files are account-wide and numbered by
    // Gardners, so a redelivered or re-collected file is a normal event, not a
    // fault. This makes reprocessing one a no-op instead of a duplicate
    // shipment — which matters because the customer-facing status and tracking
    // are derived from these rows.
    uniqueDispatchLine: uniqueIndex('uq_gardners_dropship_dispatch_line').on(
      t.dispatchNo,
      t.orderLineId,
    ),
  }),
);

export type GardnersDropshipDispatch = typeof gardnersDropshipDispatches.$inferSelect;
export type NewGardnersDropshipDispatch = typeof gardnersDropshipDispatches.$inferInsert;
