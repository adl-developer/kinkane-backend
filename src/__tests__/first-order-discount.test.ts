import { describe, it, expect, vi } from 'vitest';
import { normalizeEmailForPromotions } from '../lib/email-identity';

/**
 * The first-order promotion is money given away automatically, with no code and
 * no human in the loop. Two ways it goes wrong: the arithmetic (a discount that
 * silently costs us delivery, or a total that disagrees with what Stripe
 * charges), and the eligibility (an alias trick that makes "first" meaningless).
 */

const BASE_ENV = { ...process.env };

async function loadPricing(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/commerce/pricing');
}

const GBP_ONLY = {
  SUPPORTED_CURRENCIES: 'GBP,USD',
  DEFAULT_CURRENCY: 'GBP',
  FX_RATES_FROM_GBP: 'USD:1.25',
  FX_BUFFER_PERCENT: '0',
  VAT_RATES: 'GB:0',
  VAT_DEFAULT_RATE_PERCENT: '0',
  SHIPPING_RATES: 'GB:299,ROW:1199',
  FIRST_ORDER_DISCOUNT_PERCENT: '15',
};

const line = (unitPriceGbpPence: number, quantity = 1) => ({
  bookId: 1,
  isbn13: '9780000000001',
  quantity,
  unitPriceGbpPence,
});

describe('discount arithmetic', () => {
  it('is zero, and reason null, when no percentage is passed', async () => {
    const { quoteOrder } = await loadPricing(GBP_ONLY);
    const quote = quoteOrder({
      lines: [line(2000)],
      destinationCountry: 'GB',
      currency: 'GBP',
    });
    expect(quote.discountGbpPence).toBe(0);
    expect(quote.discountMinor).toBe(0);
    expect(quote.discountReason).toBeNull();
    expect(quote.totalMinor).toBe(quote.subtotalMinor + quote.shippingMinor + quote.taxMinor);
  });

  it('takes the percentage off the goods only, never off shipping', async () => {
    const { quoteOrder } = await loadPricing(GBP_ONLY);
    const quote = quoteOrder({
      lines: [line(2000)],
      destinationCountry: 'GB',
      currency: 'GBP',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    expect(quote.subtotalGbpPence).toBe(2000);
    expect(quote.discountGbpPence).toBe(300);
    expect(quote.shippingGbpPence).toBe(299); // untouched
    expect(quote.totalGbpPence).toBe(2000 - 300 + 299);
  });

  it('components reconcile to the total the client is shown', async () => {
    // The client renders these as separate lines. If they do not add up, the
    // customer is looking at a receipt that appears to be lying to them.
    const { quoteOrder } = await loadPricing(GBP_ONLY);
    const quote = quoteOrder({
      lines: [line(1299, 2), line(2650)],
      destinationCountry: 'GB',
      currency: 'GBP',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    expect(quote.totalMinor).toBe(
      quote.subtotalMinor - quote.discountMinor + quote.shippingMinor + quote.taxMinor,
    );
  });

  it('does not let a discount cost the buyer their free shipping', async () => {
    // £40 basket, free over £40. Discounting first would drop it to £34 and
    // charge delivery — a promotion that leaves someone worse off.
    const { quoteOrder } = await loadPricing({
      ...GBP_ONLY,
      SHIPPING_FREE_THRESHOLD_GBP_PENCE: '4000',
    });
    const quote = quoteOrder({
      lines: [line(4000)],
      destinationCountry: 'GB',
      currency: 'GBP',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    expect(quote.shippingGbpPence).toBe(0);
    expect(quote.totalGbpPence).toBe(3400);
  });

  it('taxes what was actually paid, not the pre-discount price', async () => {
    const { quoteOrder } = await loadPricing({ ...GBP_ONLY, VAT_RATES: 'GB:20' });
    const undiscounted = quoteOrder({
      lines: [line(10_000)],
      destinationCountry: 'GB',
      currency: 'GBP',
    });
    const discounted = quoteOrder({
      lines: [line(10_000)],
      destinationCountry: 'GB',
      currency: 'GBP',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    expect(undiscounted.taxGbpPence).toBeGreaterThan(discounted.taxGbpPence);
    // 20% of (10000 - 1500 + 299)
    expect(discounted.taxGbpPence).toBe(Math.round((10_000 - 1500 + 299) * 0.2));
  });

  it('reports no reason when the percentage rounds away to nothing', async () => {
    // A basket small enough that 15% is under half a penny has no discount, and
    // must not claim one on the order row.
    const { quoteOrder } = await loadPricing(GBP_ONLY);
    const quote = quoteOrder({
      lines: [line(3)],
      destinationCountry: 'GB',
      currency: 'GBP',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    expect(quote.discountGbpPence).toBe(0);
    expect(quote.discountReason).toBeNull();
  });

  it('converts the discount into the presentment currency', async () => {
    const { quoteOrder } = await loadPricing(GBP_ONLY);
    const quote = quoteOrder({
      lines: [line(2000)],
      destinationCountry: 'GB',
      currency: 'USD',
      discountPercent: 15,
      discountReason: 'first_order',
    });
    // £3.00 at 1.25 = $3.75.
    expect(quote.discountMinor).toBe(375);
    expect(quote.totalMinor).toBe(
      quote.subtotalMinor - quote.discountMinor + quote.shippingMinor + quote.taxMinor,
    );
  });
});

describe('normalizeEmailForPromotions', () => {
  it('lower-cases', () => {
    expect(normalizeEmailForPromotions('Rachel@Example.COM')).toBe('rachel@example.com');
  });

  it('collapses the +tag trick that makes a discount infinitely reusable', () => {
    expect(normalizeEmailForPromotions('rachel+1@example.com')).toBe('rachel@example.com');
    expect(normalizeEmailForPromotions('rachel+anything+else@example.com')).toBe(
      'rachel@example.com',
    );
  });

  it('collapses dots only where the provider ignores them', () => {
    expect(normalizeEmailForPromotions('ra.ch.el@gmail.com')).toBe('rachel@gmail.com');
    expect(normalizeEmailForPromotions('ra.ch.el@googlemail.com')).toBe('rachel@googlemail.com');
    // Elsewhere a dot is a real character and two addresses are two people.
    expect(normalizeEmailForPromotions('ra.chel@example.com')).toBe('ra.chel@example.com');
  });

  it('does not collapse a local part that is only a tag', () => {
    // Would otherwise normalise to `@example.com` and collide with every other
    // such address, denying strangers a discount they are entitled to.
    expect(normalizeEmailForPromotions('+tag@example.com')).toBe('+tag@example.com');
  });

  it('leaves anything that is not an address alone but lower-cased', () => {
    expect(normalizeEmailForPromotions('  NotAnEmail ')).toBe('notanemail');
  });

  it('treats the alias variants as one buyer', () => {
    const variants = [
      'Rachel.TM+first@gmail.com',
      'racheltm@gmail.com',
      'RACHEL.TM@googlemail.com',
    ].map(normalizeEmailForPromotions);
    expect(new Set([variants[0], variants[1]]).size).toBe(1);
    // Different domain, so deliberately still a different buyer — gmail and
    // googlemail deliver to the same mailbox, but proving that is not this
    // function's job.
    expect(variants[2]).toBe('racheltm@googlemail.com');
  });
});
