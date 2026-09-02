/**
 * The delivery choices offered for a basket, priced.
 *
 * This exists because the difference between Gardners' two overseas services is
 * enormous and entirely invisible to us until now: the same 400g parcel to
 * Ghana is £8.45 untracked and £32.52 tracked. Sending everything tracked, as
 * we did, is a £24 decision made on the customer's behalf without asking them.
 *
 * What a destination actually supports is read from the rate table rather than
 * assumed — coverage is genuinely uneven, and offering a service we cannot
 * price is an order we take and then cannot ship.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { measureParcel, type ParcelItem } from './parcel';
import { availableServiceCodes, quoteShipping, toPresentment, normalizeCountry } from './pricing';
import { shippingRatesService } from './shipping-rates.service';
import { GARDNERS_SERVICE_CODES } from './gardners-countries';

/** How each service is described to a customer. */
interface ServicePresentation {
  label: string;
  tracked: boolean;
  /** Working-day range quoted to the buyer, from the I12 service-code table. */
  daysMin: number;
  daysMax: number;
  /** Western Europe is quicker on both airmail services; the spec says so. */
  euDaysMin?: number;
  euDaysMax?: number;
}

const PRESENTATION: Record<string, ServicePresentation> = {
  // "Standard UK Delivery - 2nd Class Post. This offers a TWO day average
  // delivery time." Tracked by default *except* large letter, which is most
  // single-book orders — so this is not sold as a tracked service.
  [GARDNERS_SERVICE_CODES.ukStandard]: {
    label: 'Standard delivery', tracked: false, daysMin: 2, daysMax: 3,
  },
  // "Premium UK Delivery - 1st Class Post. This offers a NEXT day deliver if
  // placed before 3pm."
  [GARDNERS_SERVICE_CODES.ukPremium]: {
    label: 'Next-day delivery', tracked: false, daysMin: 1, daysMax: 2,
  },
  // "Airmail untracked... Delivery times vary from 5-7 days for Western Europe
  // to 7-10 Days elsewhere."
  [GARDNERS_SERVICE_CODES.overseasUntracked]: {
    label: 'Standard international', tracked: false,
    daysMin: 7, daysMax: 10, euDaysMin: 5, euDaysMax: 7,
  },
  [GARDNERS_SERVICE_CODES.overseasTracked]: {
    label: 'Tracked international', tracked: true,
    daysMin: 7, daysMax: 10, euDaysMin: 5, euDaysMax: 7,
  },
};

/**
 * BFPO is deliberately absent. It needs the BFPO number inside the address and
 * is a different address shape entirely, so it is a feature rather than a
 * branch — the same reasoning that keeps it out of `serviceCodeFor`.
 */
const NOT_SELECTABLE = new Set<string>([GARDNERS_SERVICE_CODES.bfpo]);

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

export interface ShippingOption {
  serviceCode: string;
  label: string;
  tracked: boolean;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  /** In the customer's currency, which is what the UI renders. */
  priceMinor: number;
  /** In GBP pence, which is what the order stores. */
  priceGbpPence: number;
  /**
   * The one to preselect. The cheapest available option, not the fastest: on
   * most overseas destinations the tracked upgrade costs more than the books.
   */
  recommended: boolean;
}

export interface ShippingOptionsResult {
  options: ShippingOption[];
  /** True when a book's weight had to be guessed to price these. */
  weightEstimated: boolean;
}

export const shippingOptionsService = {
  /**
   * Every service that can carry this basket to this country, priced.
   *
   * Returns an empty list rather than throwing when a destination cannot be
   * served at all: a cart being unable to offer delivery is a thing the UI
   * shows, and only checkout needs it to be an error.
   */
  async list(options: {
    countryCode: string;
    items: (ParcelItem & { quantity: number })[];
    subtotalGbpPence: number;
    currency: string;
    at?: Date;
  }): Promise<ShippingOptionsResult> {
    const country = normalizeCountry(options.countryCode);
    if (!country || options.items.length === 0) {
      return { options: [], weightEstimated: false };
    }

    const parcel = measureParcel(options.items);
    const itemCount = options.items.reduce((sum, item) => sum + item.quantity, 0);
    const rateCard = await shippingRatesService.load();

    const priced: ShippingOption[] = [];

    for (const serviceCode of availableServiceCodes(rateCard, country)) {
      if (NOT_SELECTABLE.has(serviceCode)) continue;

      const presentation = PRESENTATION[serviceCode];
      // A service in the table that we have no words for is a seeding mistake,
      // not something to render with a blank label.
      if (!presentation) {
        logger.warn('Shipping rate table offers a service with no presentation', { serviceCode });
        continue;
      }

      let quote;
      try {
        quote = quoteShipping({
          countryCode: country,
          serviceCode,
          itemCount,
          subtotalGbpPence: options.subtotalGbpPence,
          parcel,
          rateCard,
          at: options.at,
        });
      } catch {
        // Most often "too heavy": untracked airmail stops at 2kg while tracked
        // runs to 30kg, so a big basket legitimately loses the cheap option.
        // The other services still stand, so this is a skip, not a failure.
        continue;
      }

      const inEu = EU_COUNTRIES.has(country);
      priced.push({
        serviceCode,
        label: presentation.label,
        tracked: presentation.tracked,
        estimatedDaysMin:
          inEu && presentation.euDaysMin !== undefined ? presentation.euDaysMin : presentation.daysMin,
        estimatedDaysMax:
          inEu && presentation.euDaysMax !== undefined ? presentation.euDaysMax : presentation.daysMax,
        priceMinor: toPresentment(quote.gbpPence, options.currency),
        priceGbpPence: quote.gbpPence,
        recommended: false,
      });
    }

    priced.sort((a, b) => a.priceGbpPence - b.priceGbpPence);
    if (priced.length > 0) priced[0].recommended = true;

    return { options: priced, weightEstimated: parcel.estimated };
  },

  /**
   * Whether a service the client chose is one we actually offered.
   *
   * Checkout re-prices from the code, never from a price the client sends, so
   * this only has to establish that the code is real for the destination — but
   * it has to do that before payment, not at fulfilment.
   */
  async isAvailable(countryCode: string, serviceCode: string): Promise<boolean> {
    const country = normalizeCountry(countryCode);
    if (!country) return false;
    if (NOT_SELECTABLE.has(serviceCode)) return false;

    const rateCard = await shippingRatesService.load();
    return availableServiceCodes(rateCard, country).includes(serviceCode);
  },

  /**
   * The service to use when the client did not choose one.
   *
   * The cheapest available, which is what the cart already showed as its
   * estimate — a buyer who never saw a chooser should not be quietly upgraded
   * onto the expensive service. Falls back to the legacy country rule when the
   * rate table is off or has nothing for this destination.
   */
  async defaultServiceCode(countryCode: string): Promise<string | null> {
    if (!config.commerce.shipping.useRateTable) return null;

    const country = normalizeCountry(countryCode);
    if (!country) return null;

    const rateCard = await shippingRatesService.load();
    const available = new Set(availableServiceCodes(rateCard, country));

    // Explicit rather than relying on the codes sorting into this order, which
    // they happen to do. Cheapest first: untracked airmail is roughly a quarter
    // of tracked, and second class is cheaper than first.
    const PREFERENCE = [
      GARDNERS_SERVICE_CODES.overseasUntracked,
      GARDNERS_SERVICE_CODES.ukStandard,
      GARDNERS_SERVICE_CODES.overseasTracked,
      GARDNERS_SERVICE_CODES.ukPremium,
    ];

    return PREFERENCE.find((code) => available.has(code)) ?? null;
  },
};
