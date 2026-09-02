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
import { convertFromGbpPence, percentOf, toGbpPenceFromMinor, toStripeAmount } from '../../lib/money';
import { normalizeCountryCode } from '../../lib/country';
import type { Parcel } from './parcel';
import type { RateBand, RateCard } from './shipping-rates.service';

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

/**
 * Re-exported under the name commerce already uses. The rule itself is shared
 * with geo resolution — see lib/country.
 */
export const normalizeCountry = normalizeCountryCode;

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

/**
 * The reverse, for filter bounds only: a price range the customer typed in
 * their own currency, expressed as the GBP pence the catalogue stores.
 *
 * Not usable for charging anything — see toGbpPenceFromMinor. The buffer and
 * the round-up in the forward direction mean the boundary is approximate by up
 * to a penny either way, which is why the filter treats both bounds as
 * inclusive: showing one book a penny outside the range is a better failure
 * than hiding one inside it.
 */
export function fromPresentment(minor: number, currency: string): number {
  const code = currency.toUpperCase();
  return toGbpPenceFromMinor(minor, code, fxRateFor(code), config.commerce.currency.bufferPercent);
}

// ── Shipping ──────────────────────────────────────────────────────────────────

export interface ShippingQuote {
  gbpPence: number;
  /**
   * How this figure was arrived at, stored on the order so that "why was this
   * charged?" is answerable from the row alone months later.
   *
   * Under the flat table it is the SHIPPING_RATES key ('GB', 'EU', 'ROW'). Under
   * the rate table it is service, destination and band — '011:GH:500g'.
   */
  rule: string;
  /** The Gardners service this was priced for, when one was chosen. */
  serviceCode?: string;
  /** Despatch weight the band was picked from. */
  weightG?: number;
  /** True when a book's weight had to be guessed — see parcel.ts. */
  estimatedWeight?: boolean;
}

/** Why a destination cannot be quoted, for a caller that wants to say so. */
export class ShippingUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(message: string, readonly reason: 'no_rate' | 'too_heavy') {
    super(message);
    this.name = 'ShippingUnavailableError';
  }
}

/**
 * Whether a date falls inside Royal Mail's peak season.
 *
 * The window wraps the new year (17 November to 6 January), so "start <= today
 * <= end" is wrong for half of it. When the start is later in the year than the
 * end, the window is the union of its two halves rather than their overlap.
 */
export function isPeakSeason(at: Date): boolean {
  const { peakStartMmdd, peakEndMmdd } = config.commerce.shipping;
  // UTC rather than local time: the parcel is despatched from Eastbourne, and
  // which side of a date boundary that falls on must not depend on the timezone
  // the server happens to be running in.
  const mmdd = `${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;

  return peakStartMmdd <= peakEndMmdd
    ? mmdd >= peakStartMmdd && mmdd <= peakEndMmdd
    : mmdd >= peakStartMmdd || mmdd <= peakEndMmdd;
}

/**
 * Gardners' handling fee for a parcel: a flat charge for the first item, a
 * smaller one for the next few, and nothing after that.
 *
 * "A service fee of £0.70 per one item parcel applies, plus £0.08 per item for
 * subsequent 3 items, with no additional charge after 4 items per parcel."
 */
export function fulfilmentFeePence(itemCount: number): number {
  const { fulfilmentFirstItemPence, fulfilmentExtraItemPence, fulfilmentExtraItemLimit } =
    config.commerce.shipping;

  if (itemCount <= 0) return 0;

  const extras = Math.min(Math.max(itemCount - 1, 0), fulfilmentExtraItemLimit);
  return fulfilmentFirstItemPence + extras * fulfilmentExtraItemPence;
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
  /**
   * The weight-banded path. All three arrive together or none do: without a
   * rate card there is nothing to look a band up in, and without a parcel there
   * is no weight to look up. When they are absent — or SHIPPING_USE_RATE_TABLE
   * is off — this falls back to the flat table below.
   */
  serviceCode?: string;
  parcel?: Parcel;
  rateCard?: RateCard;
  /** When the parcel is despatched, for peak season. Defaults to now. */
  at?: Date;
}): ShippingQuote {
  const { shipping } = config.commerce;
  const country = normalizeCountry(options.countryCode) ?? REST_OF_WORLD;

  // The threshold is honoured only where SHIPPING_FREE_THRESHOLD_COUNTRIES says
  // so. An empty list means everywhere — the pre-existing behaviour, kept so
  // that emptying the variable is a way back rather than a silent change.
  const threshold = shipping.freeThresholdGbpPence;
  const thresholdApplies =
    shipping.freeThresholdCountries.length === 0 ||
    shipping.freeThresholdCountries.includes(country);
  if (threshold !== undefined && thresholdApplies && options.subtotalGbpPence >= threshold) {
    return { gbpPence: 0, rule: 'FREE_THRESHOLD' };
  }

  if (shipping.useRateTable && options.rateCard && options.parcel && options.serviceCode) {
    return quoteFromRateCard({
      country,
      serviceCode: options.serviceCode,
      parcel: options.parcel,
      rateCard: options.rateCard,
      itemCount: options.itemCount,
      at: options.at ?? new Date(),
    });
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

/**
 * Prices a parcel from the rate table.
 *
 * The figure is built up rather than looked up: postage for the band, plus
 * Gardners' fulfilment fee, plus the EU customs surcharge where it applies,
 * plus whatever margin is configured. Each part is a cost we are passed on and
 * can point at on an invoice.
 */
function quoteFromRateCard(options: {
  country: string;
  serviceCode: string;
  parcel: Parcel;
  rateCard: RateCard;
  itemCount: number;
  at: Date;
}): ShippingQuote {
  const { country, serviceCode, parcel, at } = options;
  const shipping = config.commerce.shipping;

  const bands = bandsFor(options.rateCard, country, serviceCode, parcel.fitsLargeLetter);
  if (!bands || bands.length === 0) {
    throw new ShippingUnavailableError(
      `No ${serviceCode} shipping rate for ${country}`,
      'no_rate',
    );
  }

  // The cheapest band the parcel fits inside. Bands are sorted on the way in,
  // so the first match is the cheapest one.
  const band = bands.find((candidate) => parcel.weightG <= candidate.maxWeightG);
  if (!band) {
    // Heavier than anything the carrier will take to this destination. A
    // refusal, not a fallback: quoting the top band for a parcel above it means
    // undercharging by an unbounded amount.
    throw new ShippingUnavailableError(
      `Parcel of ${parcel.weightG}g is too heavy for ${serviceCode} to ${country}`,
      'too_heavy',
    );
  }

  const peak = isPeakSeason(at) && band.peakPricePence !== null;
  const postage = peak ? band.peakPricePence! : band.pricePence;

  const surcharge = EU_COUNTRIES.has(country) ? shipping.euSurchargePence : 0;
  const cost = postage + fulfilmentFeePence(options.itemCount) + surcharge;
  const gbpPence = cost + percentOf(cost, shipping.markupPercent);

  return {
    gbpPence,
    // Enough to reconstruct the quote: which service, where to, and which band.
    rule: `${serviceCode}:${country}:${band.maxWeightG}g${peak ? ':peak' : ''}`,
    serviceCode,
    weightG: parcel.weightG,
    estimatedWeight: parcel.estimated,
  };
}

/**
 * The bands for a destination and service, preferring the large-letter prices
 * when the parcel fits one.
 *
 * Falls back to parcel prices when there is no large-letter table, which is
 * every destination except the UK — the distinction only exists in Royal Mail's
 * domestic pricing.
 */
function bandsFor(
  rateCard: RateCard,
  country: string,
  serviceCode: string,
  fitsLargeLetter: boolean,
): RateBand[] | undefined {
  const byKind = rateCard.get(country)?.get(serviceCode);
  if (!byKind) return undefined;

  if (fitsLargeLetter) {
    const largeLetter = byKind.get('large_letter');
    if (largeLetter?.length) return largeLetter;
  }

  return byKind.get('parcel');
}

/**
 * Which Gardners services can actually deliver to a destination.
 *
 * Read from the rate card rather than assumed, because the coverage is genuinely
 * uneven: Uganda is tracked-only, Tanzania untracked-only, and five countries we
 * are willing to address have no published rate at all. Offering a service we
 * cannot price is an order we take and then cannot ship.
 */
export function availableServiceCodes(rateCard: RateCard, countryCode: string): string[] {
  const country = normalizeCountry(countryCode);
  if (!country) return [];
  return [...(rateCard.get(country)?.keys() ?? [])].sort();
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
  discountGbpPence: number;
  shippingGbpPence: number;
  taxGbpPence: number;
  totalGbpPence: number;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Why a discount was applied, e.g. `first_order`. Null when there was none. */
  discountReason: string | null;
  shippingRule: string;
  /** The Gardners service the order was priced for, when one was chosen. */
  shippingServiceCode: string | null;
  /** Despatch weight the band came from, in grams. Null under the flat table. */
  shippingWeightG: number | null;
  /** True when a line's weight had to be guessed to reach that figure. */
  shippingWeightEstimated: boolean;
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
  /**
   * Percentage off the goods subtotal, 0 for none. Whether the buyer is
   * *entitled* to it is decided in checkout.service — this function only
   * applies what it is given, so pricing stays a pure function of its inputs
   * and the eligibility rule stays in one place.
   */
  discountPercent?: number;
  /** Recorded on the order when a discount applies. */
  discountReason?: string | null;
  /**
   * The weight-banded shipping inputs, passed straight through to
   * quoteShipping. Absent means the flat table prices this order — see there.
   */
  serviceCode?: string;
  parcel?: Parcel;
  rateCard?: RateCard;
  at?: Date;
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

  // Applied to the goods only — never to shipping, which is a cost we are
  // passing on rather than margin to give away.
  const discountPercent = options.discountPercent ?? 0;
  const discountGbpPence =
    discountPercent > 0 ? Math.round((subtotalGbpPence * discountPercent) / 100) : 0;

  // Deliberately quoted on the **pre-discount** subtotal. Otherwise a discount
  // can push a basket back under the free-shipping threshold and hand the buyer
  // a promotion that costs them delivery — the one outcome a promotion must
  // never produce.
  const shipping = quoteShipping({
    countryCode: options.destinationCountry,
    itemCount,
    subtotalGbpPence,
    serviceCode: options.serviceCode,
    parcel: options.parcel,
    rateCard: options.rateCard,
    at: options.at,
  });

  // Shipping is taxed alongside the goods in most regimes that tax books at
  // all, so the taxable base includes it. The discount comes off first: tax is
  // owed on what was actually paid.
  const tax = quoteTax({
    countryCode: options.destinationCountry,
    taxableGbpPence: subtotalGbpPence - discountGbpPence + shipping.gbpPence,
  });

  const totalGbpPence = config.commerce.tax.pricesIncludeTax
    ? subtotalGbpPence - discountGbpPence + shipping.gbpPence
    : subtotalGbpPence - discountGbpPence + shipping.gbpPence + tax.gbpPence;

  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  // toPresentment rounds up, which on a *discount* rounds in the customer's
  // favour by at most one minor unit. That is the right direction to err, and
  // it keeps one conversion helper rather than a second that rounds the other
  // way for the one case where up means down.
  const discountMinor = discountGbpPence > 0 ? toPresentment(discountGbpPence, currency) : 0;
  const shippingMinor = toPresentment(shipping.gbpPence, currency);
  const taxMinor = toPresentment(tax.gbpPence, currency);

  const totalMinor = config.commerce.tax.pricesIncludeTax
    ? subtotalMinor - discountMinor + shippingMinor
    : subtotalMinor - discountMinor + shippingMinor + taxMinor;

  return {
    currency,
    fxRate,
    fxCapturedAt: new Date(),
    lines,
    subtotalGbpPence,
    discountGbpPence,
    shippingGbpPence: shipping.gbpPence,
    taxGbpPence: tax.gbpPence,
    totalGbpPence,
    subtotalMinor,
    discountMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    discountReason: discountGbpPence > 0 ? (options.discountReason ?? null) : null,
    shippingRule: shipping.rule,
    shippingServiceCode: shipping.serviceCode ?? null,
    shippingWeightG: shipping.weightG ?? null,
    shippingWeightEstimated: shipping.estimatedWeight ?? false,
    taxRatePercent: tax.ratePercent,
    taxSource: tax.source,
  };
}
