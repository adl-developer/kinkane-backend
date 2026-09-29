/**
 * ISO-3166 alpha-2 country → the Gardners region codes that cover it, for
 * reading `gardners_market_restrictions`.
 *
 * A restriction row names one region and a flag: 'Y' means the title may be
 * sold *only* in its listed regions, 'N' means it may *not* be sold in them. To
 * decide whether a title is restricted for a customer we need every code that
 * could name that customer's country, which is three kinds:
 *
 *   1. **The country's own ISO code.** The feed is not consistent about its
 *      vocabulary: alongside Gardners' codes it carries plain ISO ones (`US`,
 *      `GB`, `SG`, `IS`, `EE`, `MT` …), and `UK` for Great Britain.
 *   2. **The country's Gardners code**, where Gardners has one (REGIONS.CSV,
 *      mirrored in `gardners_regions`): `USA`, `UKI`, `FRA`, `JAP` …
 *   3. **Every Gardners aggregate that contains it**: `AFR` (Africa), `EUR`
 *      (Europe), `FAR` (Far East), `MID` (Middle East), `IND` (Indian
 *      subcontinent), `SAM` (South America), `WIN` (West Indies), `BAL`
 *      (Baltic states), `YUG` (former Yugoslavia).
 *
 * Every country in our `countries` table gets an entry, even one no Gardners
 * region covers: its own ISO code is still a real mapping, and it means an
 * allowlisted title ('Y' rows elsewhere) is correctly treated as restricted
 * there rather than falling into the "no mapping" path.
 *
 * ## Judgement calls — confirm with Gardners
 *
 * REGIONS.CSV names the regions but does not say which countries each
 * aggregate contains. The memberships below are geographic, with these calls
 * made deliberately:
 *
 *   - **The UK, Isle of Man and Channel Islands are not in `EUR`.** Gardners is
 *     a UK wholesaler, and in publishing an "open market Europe" edition is the
 *     classic *export* edition that is not for UK sale. 8,018 titles are
 *     'Y EUR' (Europe only); putting GB in EUR would make every one of them
 *     sellable in the UK.
 *   - **Ireland is `EIR` + `EUR`, not `UKI`.** UKI is named "UNITED KINGDON".
 *   - **Egypt is in both `AFR` and `MID`.** Turkey is `TUR` + `EUR`. Cyprus is
 *     `CYP` + `EUR`.
 *   - **US territories (PR, VI, GU, AS, MP) are `USA` only**, not `WIN`: rights
 *     follow the US market.
 *   - **Crete (`CRE`) is not mapped**: it has no ISO code of its own, and
 *     treating all of Greece as Crete would over-apply its restrictions.
 *
 * GARDNERS_REGION_BY_COUNTRY overrides any entry here without a deploy, using
 * `|` between codes:
 *
 *   GARDNERS_REGION_BY_COUNTRY=GB:UKI|UK|GB|EUR,IE:EIR|IE|EUR|UKI
 *
 * This mapping decides two things: which books sit lower in the shop for a
 * customer (lib/shoppable), and which restricted books add-to-cart refuses
 * (availabilityService.check). Both read it through gardnersRegionsForCountry.
 */
import { config } from '../../config';

/** Gardners aggregate region → the ISO countries it contains. */
const AGGREGATES: Record<string, readonly string[]> = {
  AFR: [
    'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG', 'EH',
    'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY', 'MA', 'MG',
    'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RE', 'RW', 'SC', 'SD', 'SH', 'SL', 'SN',
    'SO', 'SS', 'ST', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'YT', 'ZA', 'ZM', 'ZW',
  ],
  EUR: [
    'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES',
    'FI', 'FO', 'FR', 'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC',
    'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SJ', 'SK',
    'SM', 'TR', 'UA', 'VA', 'XK',
  ],
  FAR: [
    'BN', 'CN', 'HK', 'ID', 'JP', 'KH', 'KP', 'KR', 'LA', 'MM', 'MN', 'MO', 'MY', 'PH', 'SG',
    'TH', 'TL', 'TW', 'VN',
  ],
  MID: [
    'AE', 'BH', 'EG', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'YE',
  ],
  IND: ['BD', 'BT', 'IN', 'LK', 'MV', 'NP', 'PK'],
  SAM: ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'],
  WIN: [
    'AG', 'AI', 'AW', 'BB', 'BL', 'BQ', 'BS', 'CU', 'CW', 'DM', 'DO', 'GD', 'GP', 'HT', 'JM',
    'KN', 'KY', 'LC', 'MF', 'MQ', 'MS', 'SX', 'TC', 'TT', 'VC', 'VG',
  ],
  BAL: ['EE', 'LT', 'LV'],
  YUG: ['BA', 'HR', 'ME', 'MK', 'RS', 'SI', 'XK'],
};

/**
 * ISO country → its own Gardners code(s). Includes the non-ISO spellings the
 * feed uses for a country (`UK` for Great Britain, `CHI` for China).
 */
const COUNTRY_CODES: Record<string, readonly string[]> = {
  AL: ['ALB'], AT: ['UST'], AU: ['AUS'], BE: ['BEL'], BG: ['BUL'], CA: ['CAN'], CH: ['SWI'],
  CN: ['CHI'], CY: ['CYP'], CZ: ['CZE'], DE: ['GER'], DK: ['DEN'], EE: ['EST'], ES: ['SPA'],
  FI: ['FIN'], FR: ['FRA'], GB: ['UKI', 'UK'], GG: ['CHA'], GR: ['GRE'], HK: ['HON'],
  HR: ['CRO'], HU: ['HUN'], IE: ['EIR'], IM: ['UKI', 'UK'], IS: ['ICE'], IT: ['ITA'],
  JE: ['CHA'], JP: ['JAP'], LI: ['LIC'], LU: ['LUX'], LV: ['LAT'], MC: ['MON'], MT: ['MAL'],
  NF: ['AUS'], NL: ['HOL'], NO: ['NOR'], NZ: ['NEW'], PL: ['POL'], PT: ['POR'], RO: ['ROM'],
  RU: ['RUS'], SE: ['SWE'], SG: ['SIN'], SI: ['SLO'], SK: ['SLV'], TH: ['THA'], TR: ['TUR'],
  UA: ['UKR'], US: ['USA'], ZA: ['SAF'],
  // US territories: US rights, not the West Indies.
  AS: ['USA', 'US'], GU: ['USA', 'US'], MP: ['USA', 'US'], PR: ['USA', 'US'], VI: ['USA', 'US'],
};

/** Every country in the `countries` table (ISO-3166 alpha-2, plus XK). */
const ALL_COUNTRIES = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR ' +
  'BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE ' +
  'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK ' +
  'HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB ' +
  'LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX ' +
  'MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA ' +
  'RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH ' +
  'TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');

function buildBuiltInMapping(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const country of ALL_COUNTRIES) {
    const codes = new Set<string>([country, ...(COUNTRY_CODES[country] ?? [])]);
    for (const [region, members] of Object.entries(AGGREGATES)) {
      if (members.includes(country)) codes.add(region);
    }
    out[country] = [...codes].sort();
  }
  return out;
}

/** The generated table, before any GARDNERS_REGION_BY_COUNTRY override. */
export const BUILT_IN_REGIONS_BY_COUNTRY: Readonly<Record<string, readonly string[]>> =
  buildBuiltInMapping();

/**
 * The effective mapping: the built-in table, with GARDNERS_REGION_BY_COUNTRY
 * replacing whole entries. Built on first use and then kept — this is
 * configuration, and it cannot change without a restart.
 */
let regionsByCountry: Record<string, readonly string[]> | null = null;

function effectiveMapping(): Record<string, readonly string[]> {
  if (regionsByCountry) return regionsByCountry;
  const overrides = config.commerce?.gardnersRegionByCountry ?? {};
  regionsByCountry = {
    ...BUILT_IN_REGIONS_BY_COUNTRY,
    ...Object.fromEntries(
      Object.entries(overrides).map(([country, codes]) => [
        country,
        codes.split('|').map((code) => code.trim().toUpperCase()).filter(Boolean).sort(),
      ]),
    ),
  };
  return regionsByCountry;
}

/**
 * Every Gardners region code that names this country, upper-cased and sorted.
 * Empty only for a code we do not know, which callers treat as "cannot tell".
 */
export function gardnersRegionsForCountry(countryCode: string): readonly string[] {
  return effectiveMapping()[countryCode.trim().toUpperCase()] ?? [];
}
