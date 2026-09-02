/**
 * Reads the shipping rate table and hands pricing a plain, in-memory rate card.
 *
 * This exists to keep pricing.ts pure. Quoting shipping is arithmetic on
 * (destination, service, weight), and the only reason it would need a database
 * is to fetch four thousand numbers that change twice a year. So the fetch
 * happens here, once, and pricing takes the result as an argument.
 *
 * The card is cached process-wide. Rates are reference data written only by the
 * seed, so a stale card means a deploy or a re-seed has happened and the TTL is
 * how long until it is noticed — minutes, not milliseconds, is the right order
 * of magnitude for something nobody edits at runtime.
 */
import { and, lte } from 'drizzle-orm';
import { db } from '../../db';
import { shippingRates } from '../../db/schema/shipping-rates';
import type { ParcelKind } from '../../db/seeds/shipping-rates';
import { logger } from '../../lib/logger';

export interface RateBand {
  /** Upper bound in grams, inclusive. */
  maxWeightG: number;
  pricePence: number;
  /** Royal Mail peak season, or null when the service has no peak price. */
  peakPricePence: number | null;
}

/**
 * country -> service -> parcel shape -> bands, ascending by weight.
 *
 * Nested Maps rather than a flat keyed string because every read is "what can I
 * do for this country", and that has to be one lookup rather than a scan.
 */
export type RateCard = Map<string, Map<string, Map<ParcelKind, RateBand[]>>>;

/**
 * Turns rate rows into a card.
 *
 * Exported for tests, which build a card from fixtures rather than a database.
 * Rows may arrive in any order; bands come out sorted, because the quote picks
 * the first band a parcel fits and that is only the cheapest one if they are in
 * order.
 */
export function buildRateCard(
  rows: {
    countryCode: string;
    serviceCode: string;
    parcelKind: ParcelKind;
    maxWeightG: number;
    pricePence: number;
    peakPricePence: number | null;
  }[],
): RateCard {
  const card: RateCard = new Map();

  for (const row of rows) {
    const country = row.countryCode.trim().toUpperCase();
    const service = row.serviceCode.trim();

    let byService = card.get(country);
    if (!byService) card.set(country, (byService = new Map()));

    let byKind = byService.get(service);
    if (!byKind) byService.set(service, (byKind = new Map()));

    const bands = byKind.get(row.parcelKind) ?? [];
    bands.push({
      maxWeightG: row.maxWeightG,
      pricePence: row.pricePence,
      peakPricePence: row.peakPricePence,
    });
    byKind.set(row.parcelKind, bands);
  }

  for (const byService of card.values()) {
    for (const byKind of byService.values()) {
      for (const bands of byKind.values()) {
        bands.sort((a, b) => a.maxWeightG - b.maxWeightG);
      }
    }
  }

  return card;
}

/**
 * How long a loaded card is trusted. Long enough that checkout never waits on
 * this query, short enough that a re-seeded correction reaches production
 * without a restart.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { card: RateCard; loadedAt: number } | null = null;
let inFlight: Promise<RateCard> | null = null;

export const shippingRatesService = {
  /**
   * The current rate card, from cache when it is fresh.
   *
   * Concurrent callers share one query rather than each starting their own —
   * without that, a cold cache under load means every simultaneous checkout
   * issues the same four-thousand-row read.
   */
  async load(): Promise<RateCard> {
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.card;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);

        // Only rates already in force. A sheet seeded ahead of its start date
        // sits in the table without affecting anything until the day it
        // begins, which is how a price rise is staged safely.
        const rows = await db
          .select({
            countryCode: shippingRates.countryCode,
            serviceCode: shippingRates.serviceCode,
            parcelKind: shippingRates.parcelKind,
            maxWeightG: shippingRates.maxWeightG,
            pricePence: shippingRates.pricePence,
            peakPricePence: shippingRates.peakPricePence,
            effectiveFrom: shippingRates.effectiveFrom,
          })
          .from(shippingRates)
          .where(and(lte(shippingRates.effectiveFrom, today)));

        // Where two sheets both apply, the later one wins. Sorting by effective
        // date and letting the last write land is what makes that true, and it
        // is the reason superseded rows can stay in the table.
        rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

        const deduped = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          deduped.set(
            `${row.countryCode}|${row.serviceCode}|${row.parcelKind}|${row.maxWeightG}`,
            row,
          );
        }

        const card = buildRateCard([...deduped.values()]);
        cached = { card, loadedAt: Date.now() };
        logger.info('Loaded shipping rate card', {
          destinations: card.size,
          rates: deduped.size,
        });
        return card;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  },

  /** Drops the cache. For tests, and for an operator after a re-seed. */
  invalidate(): void {
    cached = null;
  },
};
