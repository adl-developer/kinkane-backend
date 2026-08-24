/**
 * Currency arithmetic for the shop.
 *
 * Two rules hold everywhere below, and both exist because Gardners quotes GBP
 * and only GBP while customers are charged in their own currency:
 *
 *  1. **Money is always an integer in a currency's minor unit.** No floats, no
 *     decimals, ever — `0.1 + 0.2` is the oldest bug in commerce.
 *  2. **The minor unit is not always 1/100.** JPY, KRW and ~20 others have no
 *     minor unit at all, and Stripe rejects an amount that assumes one. Nothing
 *     here multiplies by a hardcoded 100.
 *
 * Rounding is always *away from the customer's favour* on conversion (we round
 * up), because these functions run on every line of every order and rounding
 * down loses real money at volume. That is a pricing decision, not a numerical
 * one, and it is concentrated here so it can be argued with in one place.
 */

/**
 * Currencies with no minor unit. Stripe's "zero-decimal currencies" list —
 * an amount of `500` means ¥500, not ¥5.00.
 *
 * Not exhaustive of world currencies, but exhaustive of the ones Stripe treats
 * this way, which is the only thing that matters when building a charge.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Currencies billed in thousandths. Stripe requires these to be a multiple of 100. */
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** How many minor units make one major unit of `currency`. */
export function minorUnitsPerMajor(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
  return 100;
}

/** Number of decimal places `currency` is conventionally displayed with. */
export function decimalPlaces(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Stripe requires three-decimal amounts to be a multiple of 100 — it only
 * supports two decimals of precision even for currencies that have three.
 * Applied last, after conversion and rounding, so the returned amount is
 * always one Stripe will actually accept.
 */
export function toStripeAmount(minor: number, currency: string): number {
  if (!THREE_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return minor;
  return Math.ceil(minor / 100) * 100;
}

/**
 * Converts GBP pence into `currency`'s minor unit at `rate`, padded by
 * `bufferPercent` and rounded up.
 *
 * The buffer exists because the rate table is static configuration that drifts
 * between deploys (see FX_RATES_FROM_GBP). Without it, every day since the last
 * rate update is a day of eroding margin; with it, drift eats the buffer first.
 */
export function convertFromGbpPence(
  gbpPence: number,
  currency: string,
  rate: number,
  bufferPercent = 0,
): number {
  const code = currency.toUpperCase();

  if (code === 'GBP') return Math.round(gbpPence);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw Object.assign(new Error(`No usable exchange rate for ${code}`), { statusCode: 503 });
  }

  // GBP pence -> GBP -> target major -> target minor, then up to a whole unit.
  const major = (gbpPence / 100) * rate * (1 + bufferPercent / 100);
  return Math.ceil(major * minorUnitsPerMajor(code));
}

/**
 * The inverse of convertFromGbpPence, for turning a *customer-supplied* amount
 * back into the GBP pence the catalogue stores.
 *
 * Only ever used for filter bounds, never for money that is charged. The
 * forward conversion rounds up (twice — the buffer, then the whole minor unit),
 * so this cannot round-trip exactly, and a bound that is off by a penny is
 * meaningless in a price filter. It must never be used to compute a price,
 * where that same penny is somebody's money.
 */
export function toGbpPenceFromMinor(
  minor: number,
  currency: string,
  rate: number,
  bufferPercent = 0,
): number {
  const code = currency.toUpperCase();

  if (code === 'GBP') return Math.round(minor);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw Object.assign(new Error(`No usable exchange rate for ${code}`), { statusCode: 503 });
  }

  const major = minor / minorUnitsPerMajor(code);
  return Math.round((major / (rate * (1 + bufferPercent / 100))) * 100);
}

/**
 * Formats a minor-unit amount for display/logging. Not used to build charges —
 * Stripe is always given the integer.
 */
export function formatMinor(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const places = decimalPlaces(code);
  const major = minor / minorUnitsPerMajor(code);
  return `${major.toFixed(places)} ${code}`;
}

/**
 * Applies a percentage to a minor-unit amount, rounding to the nearest unit.
 *
 * Tax rounds to nearest rather than up: unlike an FX conversion, this is a
 * figure that may have to be reconciled against a tax authority's own
 * arithmetic, and systematically rounding up would overstate what we collected.
 */
export function percentOf(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}
