import { pgTable, serial, varchar, timestamp, integer, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';
import { admins } from './admin';

/**
 * Where a restock request stands. There is no "dismissed": the client chose
 * Pending and Fulfilled only, as in the design, and "fulfilled" means "an admin
 * has dealt with this", whatever dealing with it turned out to involve.
 */
export const restockRequestStatusEnum = pgEnum('restock_request_status', ['pending', 'fulfilled']);

/**
 * "Request Restock" presses from the book page — one row per press.
 *
 * Kinkané holds no stock of its own; everything is dropshipped from Gardners,
 * and restocking is something an admin arranges with Gardners by phone or email.
 * So this table is a worklist and a demand signal, not an automation: nothing
 * happens to a book or a customer when a request is marked fulfilled. The admin
 * contacts the customer themselves.
 *
 * Deliberately **not** de-duplicated. The client's call: the same person pressing
 * twice, or ten strangers pressing once each, both read as demand, and that is
 * what the admin wants to see. The per-IP rate limit on the endpoint is the only
 * brake, and it is there for bots, not customers.
 *
 * One row per *edition*: `book_id` is the ISBN the customer was looking at, so a
 * paperback and a hardback of the same title are separate cards in the console.
 * Restocking is per ISBN at Gardners too.
 */
export const restockRequests = pgTable(
  'restock_requests',
  {
    id: serial('id').primaryKey(),
    // "RR001". Stamped after insert, from the id, the way reports get "R001".
    reference: varchar('reference', { length: 16 }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // Snapshotted, so the request still names its ISBN in an export even if the
    // catalogue row is later rewritten by an ingest.
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    // Set when a signed-in customer pressed the button. `set null` rather than
    // cascade: an account deletion should not quietly erase the demand history.
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Both optional, as in the design: a guest may leave neither. For a
    // signed-in customer these are copied from the account at request time, so
    // the admin has someone to email even after the account is gone.
    name: varchar('name', { length: 200 }),
    email: varchar('email', { length: 254 }),
    status: restockRequestStatusEnum('status').notNull().default('pending'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledBy: integer('fulfilled_by').references(() => admins.id, { onDelete: 'set null' }),
    // For the admin email, a later phase. Present now so that phase needs no
    // migration; null means no email was sent, which today is every row.
    adminEmailedAt: timestamp('admin_emailed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The console groups by edition and orders by newest request.
    bookCreatedIdx: index('idx_restock_requests_book_created').on(t.bookId, t.createdAt),
    // The sidebar badge and the Pending tab.
    statusIdx: index('idx_restock_requests_status').on(t.status),
    createdAtIdx: index('idx_restock_requests_created_at').on(t.createdAt),
  }),
);

export type RestockRequest = typeof restockRequests.$inferSelect;
