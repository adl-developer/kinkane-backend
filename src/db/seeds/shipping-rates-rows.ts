/**
 * Flattens the generated rate sheets into the rows `shipping_rates` stores.
 *
 * The generated file is grouped by service and destination because that is how
 * the vendor's spreadsheet is shaped and it keeps the diff readable when a new
 * sheet lands — one line per country, not twenty-eight. The table wants one row
 * per band, which is what this produces.
 *
 * Kept apart from the generated file so that regenerating the rates never
 * overwrites hand-written code.
 */
import type { Sql } from 'postgres';
import { SHIPPING_RATE_SEED, type ParcelKind } from './shipping-rates';

export interface ShippingRateRow {
  serviceCode: string;
  countryCode: string;
  parcelKind: ParcelKind;
  maxWeightG: number;
  pricePence: number;
  peakPricePence: number | null;
  effectiveFrom: string;
  source: string;
}

export function shippingRateRows(): ShippingRateRow[] {
  const rows: ShippingRateRow[] = [];

  for (const group of SHIPPING_RATE_SEED) {
    for (const [countryCode, prices] of Object.entries(group.pricePence)) {
      if (prices.length !== group.bandsG.length) {
        // Positional alignment between bandsG and each price array is the one
        // assumption this format rests on. If it is ever violated, every price
        // for that destination is silently attributed to the wrong weight —
        // so it fails here instead.
        throw new Error(
          `Shipping rate seed for ${group.serviceCode}/${countryCode} has ` +
            `${prices.length} prices for ${group.bandsG.length} weight bands`,
        );
      }

      const peak = group.peakPricePence?.[countryCode];

      group.bandsG.forEach((maxWeightG, index) => {
        rows.push({
          serviceCode: group.serviceCode,
          countryCode,
          parcelKind: group.parcelKind,
          maxWeightG,
          pricePence: prices[index],
          peakPricePence: peak?.[index] ?? null,
          effectiveFrom: group.effectiveFrom,
          source: group.source,
        });
      });
    }
  }

  return rows;
}

/**
 * Writes every rate into `shipping_rates`, and returns how many.
 *
 * Idempotent: the unique key is (service, country, shape, band, effective
 * date), so re-running corrects prices in place rather than accumulating a
 * second, contradictory set. A sheet with a *new* effective date adds rows
 * alongside the old ones rather than replacing them, which is what lets an old
 * order still be re-priced at the rates that were live when it was placed.
 *
 * Batched because there are roughly four thousand rows and Postgres caps the
 * number of bind parameters in a single statement at 65,535 — eight columns per
 * row puts the ceiling near 8,000, and staying well under it leaves room for
 * the sheets to grow.
 */
export async function seedShippingRates(sql: Sql): Promise<number> {
  const rows = shippingRateRows();
  const BATCH = 500;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((row) => ({
      service_code: row.serviceCode,
      country_code: row.countryCode,
      parcel_kind: row.parcelKind,
      max_weight_g: row.maxWeightG,
      price_pence: row.pricePence,
      peak_price_pence: row.peakPricePence,
      effective_from: row.effectiveFrom,
      source: row.source,
    }));

    await sql`
      INSERT INTO shipping_rates ${sql(
        batch,
        'service_code', 'country_code', 'parcel_kind', 'max_weight_g',
        'price_pence', 'peak_price_pence', 'effective_from', 'source',
      )}
      ON CONFLICT (service_code, country_code, parcel_kind, max_weight_g, effective_from)
      DO UPDATE SET
        price_pence = EXCLUDED.price_pence,
        peak_price_pence = EXCLUDED.peak_price_pence,
        source = EXCLUDED.source
    `;
  }

  return rows.length;
}
