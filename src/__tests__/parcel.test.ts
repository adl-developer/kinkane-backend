import { describe, it, expect } from 'vitest';
import { measureParcel, type ParcelItem } from '../services/commerce/parcel';

/**
 * Which weight band an order lands in is what it costs us to ship, so the two
 * failure directions are not symmetric. Under-estimating a parcel means paying
 * the difference on every order that hits the same case; over-estimating costs
 * a little margin. Every guess below is asserted to err upwards.
 */

const book = (over: Partial<ParcelItem> = {}): ParcelItem => ({
  quantity: 1,
  weightGr: 300,
  heightMm: 198,
  widthMm: 129,
  thicknessMm: 20,
  productForm: 'BC',
  ...over,
});

describe('measureParcel', () => {
  it('adds packaging to the books it is given', () => {
    const parcel = measureParcel([book({ weightGr: 300 })]);

    // A slim 300g paperback goes in a card wrap, not a box.
    expect(parcel.fitsLargeLetter).toBe(true);
    expect(parcel.weightG).toBe(340);
    expect(parcel.estimated).toBe(false);
  });

  it('multiplies by quantity', () => {
    const parcel = measureParcel([book({ weightGr: 300, quantity: 3 })]);

    // Three 20mm books are 60mm thick, well past the envelope.
    expect(parcel.fitsLargeLetter).toBe(false);
    expect(parcel.weightG).toBe(900 + 120);
  });

  it('sums across lines', () => {
    const parcel = measureParcel([
      book({ weightGr: 300, thicknessMm: 20 }),
      book({ weightGr: 450, thicknessMm: 30 }),
    ]);

    expect(parcel.weightG).toBe(750 + 120);
  });

  describe('large letter', () => {
    it('needs weight, both faces and thickness to be inside the envelope', () => {
      expect(measureParcel([book()]).fitsLargeLetter).toBe(true);
      expect(measureParcel([book({ thicknessMm: 26 })]).fitsLargeLetter).toBe(false);
      expect(measureParcel([book({ heightMm: 360 })]).fitsLargeLetter).toBe(false);
      // Both limits apply to the same book: 260mm is fine as the longer side
      // but not as the shorter one, so this fails only when both sides are big.
      expect(measureParcel([book({ widthMm: 260 })]).fitsLargeLetter).toBe(true);
      expect(measureParcel([book({ heightMm: 300, widthMm: 260 })]).fitsLargeLetter).toBe(false);
    });

    // Books are catalogued portrait, but an envelope does not care which way
    // round they go in — only that the longer side fits the longer limit.
    it('does not care which way round the book is catalogued', () => {
      expect(measureParcel([book({ heightMm: 129, widthMm: 198 })]).fitsLargeLetter).toBe(true);
    });

    // The limit is on the despatched item, so packaging has to be inside it.
    // A 740g book in a 40g wrap is 780g, which is a parcel.
    it('counts packaging against the 750g limit', () => {
      expect(measureParcel([book({ weightGr: 700 })]).fitsLargeLetter).toBe(true);
      expect(measureParcel([book({ weightGr: 740 })]).fitsLargeLetter).toBe(false);
    });

    it('stacks thickness across copies and lines', () => {
      expect(measureParcel([book({ thicknessMm: 12, quantity: 2 })]).fitsLargeLetter).toBe(true);
      expect(measureParcel([book({ thicknessMm: 13, quantity: 2 })]).fitsLargeLetter).toBe(false);
    });

    // An unknown dimension is not evidence that it fits. Quoting the cheaper
    // shape on a missing measurement is exactly the mistake that costs money at
    // scale, because thickness is missing on about a fifth of the catalogue.
    it('refuses to claim a fit when a dimension is unknown', () => {
      expect(measureParcel([book({ thicknessMm: null })]).fitsLargeLetter).toBe(false);
      expect(measureParcel([book({ heightMm: null })]).fitsLargeLetter).toBe(false);
      expect(measureParcel([book({ widthMm: null })]).fitsLargeLetter).toBe(false);
    });
  });

  describe('missing weight', () => {
    it('falls back by product form, and says that it did', () => {
      const paperback = measureParcel([book({ weightGr: null, productForm: 'BC' })]);
      const hardback = measureParcel([book({ weightGr: null, productForm: 'BB' })]);

      expect(paperback.estimated).toBe(true);
      expect(paperback.weightG).toBe(800 + 120);
      expect(hardback.weightG).toBe(1300 + 120);
    });

    it('falls back heavy for an unknown form', () => {
      const unknown = measureParcel([book({ weightGr: null, productForm: null })]);
      const nonsense = measureParcel([book({ weightGr: null, productForm: 'ZZ' })]);

      expect(unknown.weightG).toBe(1300 + 120);
      expect(nonsense.weightG).toBe(1300 + 120);
    });

    // A book recorded as weighing nothing is a data error. Treating it as
    // weightless would quote the cheapest band for a real parcel.
    it('treats a zero or negative weight as missing', () => {
      expect(measureParcel([book({ weightGr: 0 })]).estimated).toBe(true);
      expect(measureParcel([book({ weightGr: -5 })]).estimated).toBe(true);
    });

    it('is flagged as estimated when any one line was guessed', () => {
      const parcel = measureParcel([book({ weightGr: 300 }), book({ weightGr: null })]);
      expect(parcel.estimated).toBe(true);
    });

    it('is not flagged when every line had a real weight', () => {
      expect(measureParcel([book(), book()]).estimated).toBe(false);
    });
  });

  it('rounds a fractional weight up to the next gram', () => {
    // ONIX carries weights to two decimals, and a band boundary should not be
    // crossed by rounding in the customer's favour.
    expect(measureParcel([book({ weightGr: 300.4 })]).weightG).toBe(341);
  });

  it('weighs an empty basket as packaging alone', () => {
    // Nothing quotes an empty basket, but returning NaN or a negative from this
    // would surface somewhere far away from here.
    const parcel = measureParcel([]);
    expect(parcel.weightG).toBeGreaterThan(0);
    expect(parcel.estimated).toBe(false);
  });
});
