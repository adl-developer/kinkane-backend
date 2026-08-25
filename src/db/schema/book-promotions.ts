/**
 * Kinkané's own markdowns.
 *
 * **This exists because no Gardners feed carries a customer-facing sale
 * price.** GARDPROM13 looked like the obvious source and is not: its `price`
 * equals `gardners_stock.rrp_gbp` on essentially every row, and its
 * `discount_percent` matches the trade discount on that same table — i.e. it
 * describes *our* margin during a supplier promotion, not a reduction for the
 * buyer. Publishing it would both disclose our commercial terms and advertise a
 * discount checkout would refuse to honour.
 *
 * So a sale price is a decision this business makes and stores here. The table
 * ships empty; a book with no active row is simply not on sale.
 *
 * The sale price is read by `availabilityService.check()` — the single gate
 * every add-to-cart and checkout already goes through — so the price on a
 * shelf, the price in the basket and the price Stripe charges cannot diverge.
 * Anything that surfaces a sale price by another route would reintroduce
 * exactly that divergence.
 */
import { pgTable, serial, integer, varchar, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { books } from './books';

export const bookPromotions = pgTable(
  'book_promotions',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),

    /**
     * What the customer pays while this promotion is live, in GBP pence —
     * the same unit and currency as `gardners_stock.rrp_gbp` converts to, so
     * the two are directly comparable without a rounding step.
     *
     * An absolute price rather than a percentage on purpose: a percentage has
     * to be recomputed against an RRP that moves with the daily feed, which
     * means the advertised price can change without anyone deciding it should.
     */
    salePriceGbpPence: integer('sale_price_gbp_pence').notNull(),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null runs until someone ends it. */
    endsAt: timestamp('ends_at', { withTimezone: true }),

    /** Why this markdown exists — operator-facing, never shown to a customer. */
    note: varchar('note', { length: 500 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Drives the correlated lookup in availabilityService: by book, filtered on
    // the window.
    bookWindowIdx: index('idx_book_promotions_book_window').on(t.bookId, t.startsAt, t.endsAt),
    // A free or negative sale price is always a data-entry accident, and the
    // blast radius is selling books for nothing.
    positivePrice: check('ck_book_promotions_price_positive', sql`${t.salePriceGbpPence} > 0`),
    // A window that closes before it opens would never fire; catching it on
    // write is better than a promotion that silently does nothing.
    orderedWindow: check(
      'ck_book_promotions_window_ordered',
      sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

export type BookPromotion = typeof bookPromotions.$inferSelect;
export type NewBookPromotion = typeof bookPromotions.$inferInsert;
