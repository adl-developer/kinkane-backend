import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_REGIONS_BY_COUNTRY,
  gardnersRegionsForCountry,
} from '../services/commerce/gardners-regions';

// The mapping decides which books sit lower in the shop for a customer and which
// restricted books add-to-cart refuses, so its shape is pinned here: a country that
// falls out of it silently becomes "cannot tell", which blocks every restricted title.

// Region codes that appear in gardners_regions or in the restriction feed.
const GARDNERS_CODES = new Set([
  'AFR', 'ALB', 'AUS', 'BAL', 'BEL', 'BUL', 'CAN', 'CHA', 'CHI', 'CRO', 'CYP', 'CZE', 'DEN',
  'EIR', 'EST', 'EUR', 'FAR', 'FIN', 'FRA', 'GER', 'GRE', 'HOL', 'HON', 'HUN', 'ICE', 'IND',
  'ITA', 'JAP', 'LAT', 'LIC', 'LUX', 'MAL', 'MID', 'MON', 'NEW', 'NOR', 'POL', 'POR', 'ROM',
  'RUS', 'SAF', 'SAM', 'SIN', 'SLO', 'SLV', 'SPA', 'SWE', 'SWI', 'THA', 'TUR', 'UK', 'UKI',
  'UKR', 'USA', 'UST', 'WIN', 'YUG',
]);

describe('the built-in Gardners region mapping', () => {
  const countries = Object.keys(BUILT_IN_REGIONS_BY_COUNTRY);

  it('covers every country we can sell to', () => {
    // 241 = the `countries` table.
    expect(countries.length).toBe(241);
  });

  it('always includes the country\'s own ISO code, which the feed also uses', () => {
    for (const country of countries) {
      expect(BUILT_IN_REGIONS_BY_COUNTRY[country]).toContain(country);
    }
  });

  it('uses only ISO codes and codes Gardners actually sends', () => {
    for (const [country, codes] of Object.entries(BUILT_IN_REGIONS_BY_COUNTRY)) {
      for (const code of codes) {
        const known = code in BUILT_IN_REGIONS_BY_COUNTRY || GARDNERS_CODES.has(code);
        expect(known, `${country} → ${code}`).toBe(true);
      }
    }
  });

  it('maps the countries we ship to most', () => {
    expect(gardnersRegionsForCountry('GH')).toEqual(['AFR', 'GH']);
    expect(gardnersRegionsForCountry('NG')).toEqual(['AFR', 'NG']);
    expect(gardnersRegionsForCountry('US')).toEqual(['US', 'USA']);
    expect(gardnersRegionsForCountry('ZA')).toEqual(['AFR', 'SAF', 'ZA']);
    expect(gardnersRegionsForCountry('FR')).toEqual(['EUR', 'FR', 'FRA']);
  });

  it('keeps the UK out of Europe, so Europe-only export editions stay unsellable there', () => {
    const gb = gardnersRegionsForCountry('GB');
    expect(gb).toEqual(['GB', 'UK', 'UKI']);
    expect(gb).not.toContain('EUR');
  });

  it('is case- and whitespace-insensitive, and empty for a code it does not know', () => {
    expect(gardnersRegionsForCountry(' gh ')).toEqual(['AFR', 'GH']);
    expect(gardnersRegionsForCountry('ZZ')).toEqual([]);
  });
});
