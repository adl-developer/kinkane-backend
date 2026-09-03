/**
 * What Gardners charge us to ship a parcel, by service, destination and weight.
 *
 * Reference data: written only by the seed in db/seeds/shipping-rates.ts, read
 * on every quote. It replaces the flat SHIPPING_RATES environment table, which
 * could not express the thing that actually drives the cost — a parcel to Ghana
 * costs £30.61 at 250g and £104.98 at 10kg, and one flat number for "rest of
 * world" is wrong at both ends.
 *
 * These are **costs, not prices**. The fulfilment fee, the EU customs surcharge
 * and any margin are added on top at quote time; nothing here has been marked
 * up. Keeping the vendor's numbers unmodified is what makes an invoice
 * reconcilable against an order.
 *
 * A table rather than a config string because there are ~4,000 figures, they
 * are reissued a couple of times a year, and re-pricing should be a re-seed
 * rather than a deploy.
 */
import { pgTable, pgEnum, serial, integer, char, varchar, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Royal Mail prices a "large letter" (max 35.3 × 25 × 2.5cm, 750g) well below a
 * parcel, and Gardners send whichever the item fits — the I12 service-code
 * table says packages are "tracked by default excluding Large Letter". So one
 * UK service code has two price structures, and which applies is decided by the
 * book's dimensions, not by anything we choose.
 *
 * Every international rate is a parcel: the distinction is a UK-only artefact.
 */
export const parcelKindEnum = pgEnum('parcel_kind', ['large_letter', 'parcel']);

export const shippingRates = pgTable(
  'shipping_rates',
  {
    id: serial('id').primaryKey(),

    // Gardners' I12 Home Delivery service code — '001' UK standard, '002' UK
    // premium, '010' airmail untracked, '011' airmail tracked, '015' BFPO.
    // Stored as the three-character string the EDI file carries, leading zero
    // and all, so there is no place for a number-to-string conversion to lose
    // it.
    serviceCode: char('service_code', { length: 3 }).notNull(),
    countryCode: char('country_code', { length: 2 }).notNull(),
    parcelKind: parcelKindEnum('parcel_kind').notNull(),

    /**
     * Upper bound of the weight band, in grams, inclusive. A parcel is priced
     * at the cheapest band it fits inside; one heavier than every band for its
     * destination cannot be quoted, which is a refusal rather than a fallback.
     */
    maxWeightG: integer('max_weight_g').notNull(),

    pricePence: integer('price_pence').notNull(),
    /**
     * Royal Mail's peak-season price (17 November to 6 January). Null on
     * everything except the UK large letter, which is the only service that has
     * one — for the rest, null means "the ordinary price applies year round"
     * rather than "unknown".
     */
    peakPricePence: integer('peak_price_pence'),

    /**
     * When this price came into force. Rows are never updated in place: a new
     * sheet is seeded as a new effective date and the quote picks the latest
     * one not in the future, so an order placed last month can still be
     * re-priced with the rates that were live when it was placed.
     */
    effectiveFrom: date('effective_from').notNull(),
    /** Which sheet this came from, e.g. 'gardners-international-cdf-2026-07'. */
    source: varchar('source', { length: 60 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One price per service, destination, shape, band and effective date. This
    // is what makes the seed idempotent: re-running it conflicts on this key
    // and updates rather than inserting a second, contradictory price.
    uniqueRate: uniqueIndex('uniq_shipping_rates_lookup').on(
      t.serviceCode,
      t.countryCode,
      t.parcelKind,
      t.maxWeightG,
      t.effectiveFrom,
    ),
    // The quote path reads every band for one destination at once, which is
    // this index. Country first because that is the selective column: 240
    // destinations against 5 service codes.
    destinationIdx: index('idx_shipping_rates_destination').on(
      t.countryCode,
      t.serviceCode,
      t.effectiveFrom,
    ),
  }),
);

export type ShippingRate = typeof shippingRates.$inferSelect;
export type NewShippingRate = typeof shippingRates.$inferInsert;
