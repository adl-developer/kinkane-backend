/**
 * Pricing rules: currency resolution, FX, shipping and tax.
 *
 * Everything in this file is a **pure function of (amount, country, config)**.
 * No database, no Redis, no request object. That is deliberate: these are the
 * calculations that decide what a real person is charged, they are driven
 * entirely by operator-editable environment configuration, and the only way to
 * have confidence in them is to be able to test every branch without standing
 * anything up. See src/__tests__/commerce-pricing.test.ts.
 *
 * The one thing that is *not* pure — reading the country off an inbound
 * request — lives in `resolveRequestCountry` at the bottom, which touches
 * nothing but headers.
 */
import type { Request } from 'express';
import { config } from '../../config';
import { geoService } from '../geo.service';
import { convertFromGbpPence, percentOf, toStripeAmount } from '../../lib/money';

/**
 * EU member states, used only to resolve the `EU` shipping/VAT bucket when a
 * country has no rule of its own. Membership changes roughly once a decade;
 * when it does, this list and the operator's env tables both need updating.
 */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

/** Fallback bucket for a destination with no country rule and no region rule. */
const REST_OF_WORLD = 'ROW';

// ── Country ───────────────────────────────────────────────────────────────────

/** Two ASCII letters. Cloudflare sends 'XX' for unresolvable and 'T1' for Tor. */
export function normalizeCountry(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX') return null;
  return code;
}

/**
 * Best guess at where an inbound request is coming from, for *presentation*
 * only — which currency to show. It never decides what someone is allowed to
 * buy, and it is never the shipping destination: that is collected explicitly
 * at checkout, because a VPN must not be able to change what we charge for
 * postage.
 *
 * Delegates to `geoService`, which owns country resolution for the whole server
 * (trusted proxy header first, then a local MaxMind database). Commerce
 * deliberately does not do its own header lookup: currency display and referral
 * scoring have to agree about where a request came from, and two independent
 * implementations would eventually disagree.
 *
 * One difference from how referrals use it. `geoService` resolves a country
 * once at signup and freezes it on the user row, so a travelling user cannot
 * shift continent mid-competition. Currency must NOT reuse that frozen value —
 * someone who signed up in Lagos and now lives in Berlin should see EUR — so
 * this resolves live, per request.
 *
 * Never throws: geo resolution failing must not be able to break a cart read.
 */
export async function resolveRequestCountry(req: Request): Promise<string | null> {
  try {
    const { code } = await geoService.resolveFromRequest(req);
    return normalizeCountry(code);
  } catch {
    return null;
  }
}

// ── Currency ──────────────────────────────────────────────────────────────────

export function isSupportedCurrency(currency: string): boolean {
  return config.commerce.currency.supported.includes(currency.toUpperCase());
}

/**
 * Which currency to present prices in.
 *
 * Order: explicit request → country mapping → DEFAULT_CURRENCY. An unsupported
 * explicit choice is ignored rather than rejected — a stale client sending a
 * currency we have stopped supporting should see a priced cart, not an error.
 */
export function resolveCurrency(options: {
  requested?: string | null;
  countryCode?: string | null;
}): string {
  const { currency } = config.commerce;

  const requested = options.requested?.toUpperCase();
  if (requested && isSupportedCurrency(requested)) return requested;

  const country = normalizeCountry(options.countryCode);
  if (country) {
    const mapped = currency.byCountry[country];
    if (mapped && isSupportedCurrency(mapped)) return mapped;
  }

  return currency.default;
}

/**
 * The GBP→currency rate actually applied, buffer included. GBP is always 1.
 *
 * Throws 503 rather than falling back to an unbuffered or stale rate: a missing
 * rate for a currency we claim to support is a misconfiguration, and guessing
 * would mean charging someone a number nobody chose.
 */
export function fxRateFor(currency: string): number {
  const code = currency.toUpperCase();
  if (code === 'GBP') return 1;

  const rate = config.commerce.currency.fxFromGbp[code];
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw Object.assign(new Error(`No exchange rate configured for ${code}`), { statusCode: 503 });
  }

  return rate;
}

/** Converts a GBP pence amount into `currency`, applying the configured buffer. */
export function toPresentment(gbpPence: number, currency: string): number {
  const code = currency.toUpperCase();
  return toStripeAmount(
    convertFromGbpPence(gbpPence, code, fxRateFor(code), config.commerce.currency.bufferPercent),
    code,
  );
}

// ── Shipping ──────────────────────────────────────────────────────────────────

export interface ShippingQuote {
  gbpPence: number;
  /** Which SHIPPING_RATES key produced it — stored on the order for audit. */
  rule: string;
}

/**
 * Shipping cost for a destination, in GBP pence.
 *
 * Resolution is most-specific-first: exact country → `EU` (for member states)
 * → `ROW`. A free-shipping threshold, when configured, overrides everything.
 *
 * Worth knowing: Gardners bills us **per line** (`deliveryGbpPence` on each
 * dropship DETAIL record), so a flat per-order rate on a five-book basket is a
 * margin decision, not a neutral default. SHIPPING_PER_ITEM_GBP_PENCE is the
 * lever if that turns out to hurt.
 */
export function quoteShipping(options: {
  countryCode: string;
  itemCount: number;
  subtotalGbpPence: number;
}): ShippingQuote {
  const { shipping } = config.commerce;
  const country = normalizeCountry(options.countryCode) ?? REST_OF_WORLD;

  const threshold = shipping.freeThresholdGbpPence;
  if (threshold !== undefined && options.subtotalGbpPence >= threshold) {
    return { gbpPence: 0, rule: 'FREE_THRESHOLD' };
  }

  const rule =
    country in shipping.rates
      ? country
      : EU_COUNTRIES.has(country) && 'EU' in shipping.rates
        ? 'EU'
        : REST_OF_WORLD;

  const base = shipping.rates[rule];
  if (base === undefined) {
    // ROW itself is missing from the table. Refusing to quote is the only safe
    // answer — shipping free by accident to an arbitrary country is worse than
    // an operator seeing a 503 the first time they ship somewhere new.
    throw Object.assign(
      new Error('Shipping is not configured for this destination'),
      { statusCode: 503 },
    );
  }

  return {
    gbpPence: base + shipping.perItemGbpPence * options.itemCount,
    rule,
  };
}

// ── Tax ───────────────────────────────────────────────────────────────────────

export interface TaxQuote {
  ratePercent: number;
  gbpPence: number;
  source: 'env';
}

/**
 * VAT for a destination.
 *
 * The launch default of 0 is genuinely correct rather than a shortcut:
 * physical books are zero-rated in the UK and Ireland, and on export we do not
 * collect destination VAT at all — the recipient is billed import VAT and duty
 * at the border by the carrier.
 *
 * **That last part is the real exposure, and no amount of config fixes it.**
 * Shipping anywhere (the current policy) means some customers will receive a
 * customs bill they were not told about at checkout, which is a refund and
 * chargeback generator. The mitigation is disclosure in the checkout UI and
 * confirmation email, not a rate table.
 *
 * This cannot express EU OSS thresholds, US sales-tax nexus, or duty. It is a
 * documented stopgap; Stripe Tax is the replacement when volume justifies it,
 * and `source` is returned (and stored) so those rows stay findable.
 */
export function quoteTax(options: { countryCode: string; taxableGbpPence: number }): TaxQuote {
  const { tax } = config.commerce;
  const country = normalizeCountry(options.countryCode);

  const ratePercent =
    country && country in tax.rates ? tax.rates[country] : tax.defaultRatePercent;

  if (ratePercent === 0) {
    return { ratePercent: 0, gbpPence: 0, source: 'env' };
  }

  // Inclusive pricing means the amount already contains the tax, so the tax
  // element is extracted from it rather than added to it — and comes out of our
  // margin. Exclusive is the default; see VAT_PRICES_INCLUDE_TAX.
  const gbpPence = tax.pricesIncludeTax
    ? Math.round(options.taxableGbpPence - options.taxableGbpPence / (1 + ratePercent / 100))
    : percentOf(options.taxableGbpPence, ratePercent);

  return { ratePercent, gbpPence, source: 'env' };
}

// ── Whole-order quote ─────────────────────────────────────────────────────────

export interface QuoteLine {
  bookId: number;
  isbn13: string;
  quantity: number;
  unitPriceGbpPence: number;
}

export interface PricedLine extends QuoteLine {
  lineTotalGbpPence: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface OrderQuote {
  currency: string;
  fxRate: number;
  fxCapturedAt: Date;
  lines: PricedLine[];
  subtotalGbpPence: number;
  shippingGbpPence: number;
  taxGbpPence: number;
  totalGbpPence: number;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  shippingRule: string;
  taxRatePercent: number;
  taxSource: 'env';
}

/**
 * Prices a whole basket for a destination and currency.
 *
 * The total is summed from the already-converted components rather than
 * converted from the GBP total. Those differ by a penny or two thanks to
 * per-component rounding, and the version that must be internally consistent is
 * the one the customer sees: a receipt whose lines do not add up to its total
 * is the kind of thing people photograph and post.
 */
export function quoteOrder(options: {
  lines: QuoteLine[];
  destinationCountry: string;
  currency: string;
}): OrderQuote {
  const currency = options.currency.toUpperCase();
  const fxRate = fxRateFor(currency);

  const lines: PricedLine[] = options.lines.map((line) => {
    const lineTotalGbpPence = line.unitPriceGbpPence * line.quantity;
    return {
      ...line,
      lineTotalGbpPence,
      unitPriceMinor: toPresentment(line.unitPriceGbpPence, currency),
      lineTotalMinor: toPresentment(lineTotalGbpPence, currency),
    };
  });

  const subtotalGbpPence = lines.reduce((sum, line) => sum + line.lineTotalGbpPence, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const shipping = quoteShipping({
    countryCode: options.destinationCountry,
    itemCount,
    subtotalGbpPence,
  });

  // Shipping is taxed alongside the goods in most regimes that tax books at
  // all, so the taxable base includes it.
  const tax = quoteTax({
    countryCode: options.destinationCountry,
    taxableGbpPence: subtotalGbpPence + shipping.gbpPence,
  });

  const totalGbpPence = config.commerce.tax.pricesIncludeTax
    ? subtotalGbpPence + shipping.gbpPence
    : subtotalGbpPence + shipping.gbpPence + tax.gbpPence;

  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const shippingMinor = toPresentment(shipping.gbpPence, currency);
  const taxMinor = toPresentment(tax.gbpPence, currency);

  const totalMinor = config.commerce.tax.pricesIncludeTax
    ? subtotalMinor + shippingMinor
    : subtotalMinor + shippingMinor + taxMinor;

  return {
    currency,
    fxRate,
    fxCapturedAt: new Date(),
    lines,
    subtotalGbpPence,
    shippingGbpPence: shipping.gbpPence,
    taxGbpPence: tax.gbpPence,
    totalGbpPence,
    subtotalMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    shippingRule: shipping.rule,
    taxRatePercent: tax.ratePercent,
    taxSource: tax.source,
  };
}
