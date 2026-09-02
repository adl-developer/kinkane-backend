import { describe, it, expect } from 'vitest';
import { SHIPPING_RATE_SEED } from '../db/seeds/shipping-rates';
import { shippingRateRows } from '../db/seeds/shipping-rates-rows';
import { deliverableCountryCodes } from '../services/commerce/gardners-countries';

/**
 * The rate seed is generated from a vendor spreadsheet by a script nobody runs
 * often, and a wrong figure in it is money rather than a rendering bug. These
 * are the invariants that a bad regeneration would break — the kind of thing
 * that is invisible in a 340-line diff of numbers.
 */

/**
 * Destinations we are willing to address a parcel to, for which Gardners
 * publish no price at all. They are in neither the tracked nor the untracked
 * sheet, and the quote path refuses them rather than guessing.
 *
 * This list existing is the bug, not the test. It is written down so that a
 * *new* gap — a country that quietly falls out of the next sheet — fails the
 * build instead of failing a customer's checkout.
 */
const NO_PUBLISHED_RATE = ['ET', 'LR', 'RW', 'SL', 'SN'];

/**
 * Deliverable destinations that only appear on the untracked sheet. We default
 * every overseas order to tracked, so without a fallback these are orders we
 * would accept and then be unable to price.
 */
const UNTRACKED_ONLY = ['CM', 'GM', 'TZ'];

describe('shipping rate seed', () => {
  it('aligns every price array with its weight bands', () => {
    // shippingRateRows throws on a mismatch; this asserts it does not have to.
    expect(() => shippingRateRows()).not.toThrow();

    for (const group of SHIPPING_RATE_SEED) {
      for (const [iso, prices] of Object.entries(group.pricePence)) {
        expect(prices, `${group.serviceCode}/${iso}`).toHaveLength(group.bandsG.length);
      }
    }
  });

  it('has ascending weight bands', () => {
    for (const group of SHIPPING_RATE_SEED) {
      const sorted = [...group.bandsG].sort((a, b) => a - b);
      expect(group.bandsG, group.serviceCode).toEqual(sorted);
      expect(new Set(group.bandsG).size).toBe(group.bandsG.length);
    }
  });

  // A heavier parcel never costs less than a lighter one on the same service.
  // A transcribed price that goes backwards is the signature of a column read
  // out of alignment, which would misprice every destination below it.
  it('never gets cheaper as a parcel gets heavier', () => {
    for (const group of SHIPPING_RATE_SEED) {
      for (const [iso, prices] of Object.entries(group.pricePence)) {
        for (let i = 1; i < prices.length; i += 1) {
          expect(
            prices[i],
            `${group.serviceCode}/${iso} at ${group.bandsG[i]}g`,
          ).toBeGreaterThanOrEqual(prices[i - 1]);
        }
      }
    }
  });

  it('prices every rate above zero', () => {
    for (const row of shippingRateRows()) {
      expect(row.pricePence, `${row.serviceCode}/${row.countryCode}`).toBeGreaterThan(0);
      if (row.peakPricePence !== null) {
        // Peak is a surcharge; a peak price below the ordinary one would mean
        // the two columns were read the wrong way round.
        expect(row.peakPricePence).toBeGreaterThanOrEqual(row.pricePence);
      }
    }
  });

  it('covers every country we are willing to deliver to', () => {
    const priced = new Set(shippingRateRows().map((row) => row.countryCode));
    const missing = deliverableCountryCodes().filter((code) => !priced.has(code));

    expect(missing.sort()).toEqual([...NO_PUBLISHED_RATE].sort());
  });

  it('records which deliverable countries have no tracked service', () => {
    const tracked = new Set(
      shippingRateRows()
        .filter((row) => row.serviceCode === '011')
        .map((row) => row.countryCode),
    );

    const untrackedOnly = deliverableCountryCodes().filter(
      (code) => code !== 'GB' && !tracked.has(code) && !NO_PUBLISHED_RATE.includes(code),
    );

    expect(untrackedOnly.sort()).toEqual([...UNTRACKED_ONLY].sort());
  });

  it('seeds the UK on both parcel shapes for both speeds', () => {
    const uk = shippingRateRows().filter((row) => row.countryCode === 'GB');
    const shapes = new Set(uk.map((row) => `${row.serviceCode}:${row.parcelKind}`));

    expect(shapes).toContain('001:large_letter');
    expect(shapes).toContain('001:parcel');
    expect(shapes).toContain('002:large_letter');
    expect(shapes).toContain('002:parcel');
    // BFPO rides on the 2nd class large letter price.
    expect(shapes).toContain('015:large_letter');
  });

  // Peak season is a Royal Mail large-letter thing. Anything else carrying a
  // peak price means the PDF was transcribed into the wrong rows.
  it('carries a peak price only on UK large letters', () => {
    for (const row of shippingRateRows()) {
      if (row.peakPricePence !== null) {
        expect(row.countryCode).toBe('GB');
        expect(row.parcelKind).toBe('large_letter');
      }
    }
  });
});
