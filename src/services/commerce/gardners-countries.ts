/**
 * ISO-3166 alpha-2 → the country *name* Gardners' I12 Home Delivery interface
 * expects in the ICOUNTRY / DCOUNTRY fields.
 *
 * ## Why this file is a best-effort list and not the real one
 *
 * The authoritative list is **not in the I12 specification PDF**. Page 9 says,
 * verbatim: "DCOUNTRY and ICOUNTRY fields must always contain the full country
 * as listed in the 'I12d FTP Country List.txt' file", and that file is
 * distributed separately — "If you require a copy of the 'I12d FTP Country
 * List.txt' eMail: ITServices@gardners.com". We do not have it.
 *
 * The stakes of getting a name wrong are spelled out on the same page: an
 * unrecognised country is "manually reviewed by our customer support team...
 * Any manual intervention will delay the order processing, and for repeat
 * offenders could also result in your account being suspended".
 *
 * So the entries below are **not guessed at scale**. Each is tagged with how
 * much it can be trusted:
 *
 *   [VERIFIED]   Submitted by us and accepted by Gardners in a real .ACK.
 *   [SPEC]       Appears verbatim in the specification's own worked examples.
 *   [UNVERIFIED] Our own best guess at the name Gardners uses. Plausible, and
 *                consistent in style with the confirmed entries (full name,
 *                upper case, no abbreviations), but unconfirmed.
 *
 * ## Getting rid of the guesswork
 *
 * One email to ITServices@gardners.com (quoting the account number) replaces
 * this whole list. When it arrives, either correct the table below or — with no
 * deploy at all — set GARDNERS_COUNTRY_NAMES_EXTRA, which overrides and extends
 * anything here:
 *
 *   GARDNERS_COUNTRY_NAMES_EXTRA=KR:KOREA REPUBLIC OF,CI:COTE D IVOIRE
 *
 * Page 9 also warns that the list keeps retired names for historic continuity,
 * so some countries appear more than once under different names — which is
 * exactly why a name generated from ISO or CLDR data cannot be trusted to be
 * the *current* one Gardners wants. That is the reason this file is a hand-kept
 * table rather than `Intl.DisplayNames`.
 */
import { config } from '../../config';

/**
 * Names in the style the two confirmed entries use: full name, upper case, no
 * abbreviations, no punctuation beyond what the name itself carries.
 */
const BUILT_IN_COUNTRY_NAMES: Record<string, string> = {
  // ── Confirmed against real traffic ─────────────────────────────────────────
  GB: 'UNITED KINGDOM', // [SPEC] both worked examples; also the documented default
  GH: 'GHANA', // [VERIFIED] orders 000000043 / 000000044, accepted, refs issued

  // ── Europe ─────────────────────────────────────────────────────────────────
  IE: 'IRELAND', // [UNVERIFIED]
  FR: 'FRANCE', // [UNVERIFIED]
  DE: 'GERMANY', // [UNVERIFIED]
  ES: 'SPAIN', // [UNVERIFIED]
  IT: 'ITALY', // [UNVERIFIED]
  PT: 'PORTUGAL', // [UNVERIFIED]
  NL: 'NETHERLANDS', // [UNVERIFIED]
  BE: 'BELGIUM', // [UNVERIFIED]
  LU: 'LUXEMBOURG', // [UNVERIFIED]
  AT: 'AUSTRIA', // [UNVERIFIED]
  CH: 'SWITZERLAND', // [UNVERIFIED]
  DK: 'DENMARK', // [UNVERIFIED]
  SE: 'SWEDEN', // [UNVERIFIED]
  NO: 'NORWAY', // [UNVERIFIED]
  FI: 'FINLAND', // [UNVERIFIED]
  IS: 'ICELAND', // [UNVERIFIED]
  PL: 'POLAND', // [UNVERIFIED]
  CZ: 'CZECH REPUBLIC', // [UNVERIFIED] — Gardners keeps historic names; may be CZECHIA
  SK: 'SLOVAKIA', // [UNVERIFIED]
  HU: 'HUNGARY', // [UNVERIFIED]
  RO: 'ROMANIA', // [UNVERIFIED]
  BG: 'BULGARIA', // [UNVERIFIED]
  GR: 'GREECE', // [UNVERIFIED]
  HR: 'CROATIA', // [UNVERIFIED]
  SI: 'SLOVENIA', // [UNVERIFIED]
  EE: 'ESTONIA', // [UNVERIFIED]
  LV: 'LATVIA', // [UNVERIFIED]
  LT: 'LITHUANIA', // [UNVERIFIED]
  CY: 'CYPRUS', // [UNVERIFIED]
  MT: 'MALTA', // [UNVERIFIED]

  // ── Africa ─────────────────────────────────────────────────────────────────
  NG: 'NIGERIA', // [UNVERIFIED]
  KE: 'KENYA', // [UNVERIFIED]
  ZA: 'SOUTH AFRICA', // [UNVERIFIED]
  TZ: 'TANZANIA', // [UNVERIFIED]
  UG: 'UGANDA', // [UNVERIFIED]
  RW: 'RWANDA', // [UNVERIFIED]
  ET: 'ETHIOPIA', // [UNVERIFIED]
  SN: 'SENEGAL', // [UNVERIFIED]
  CM: 'CAMEROON', // [UNVERIFIED]
  EG: 'EGYPT', // [UNVERIFIED]
  MA: 'MOROCCO', // [UNVERIFIED]
  ZM: 'ZAMBIA', // [UNVERIFIED]
  ZW: 'ZIMBABWE', // [UNVERIFIED]
  BW: 'BOTSWANA', // [UNVERIFIED]
  NA: 'NAMIBIA', // [UNVERIFIED]
  SL: 'SIERRA LEONE', // [UNVERIFIED]
  LR: 'LIBERIA', // [UNVERIFIED]
  GM: 'GAMBIA', // [UNVERIFIED]

  // ── Americas ───────────────────────────────────────────────────────────────
  US: 'UNITED STATES', // [UNVERIFIED] — may be UNITED STATES OF AMERICA
  CA: 'CANADA', // [UNVERIFIED]
  MX: 'MEXICO', // [UNVERIFIED]
  BR: 'BRAZIL', // [UNVERIFIED]
  AR: 'ARGENTINA', // [UNVERIFIED]
  CL: 'CHILE', // [UNVERIFIED]
  CO: 'COLOMBIA', // [UNVERIFIED]
  PE: 'PERU', // [UNVERIFIED]
  JM: 'JAMAICA', // [UNVERIFIED]
  TT: 'TRINIDAD AND TOBAGO', // [UNVERIFIED]
  BB: 'BARBADOS', // [UNVERIFIED]

  // ── Asia-Pacific & Middle East ─────────────────────────────────────────────
  AU: 'AUSTRALIA', // [UNVERIFIED]
  NZ: 'NEW ZEALAND', // [UNVERIFIED]
  JP: 'JAPAN', // [UNVERIFIED]
  CN: 'CHINA', // [UNVERIFIED]
  HK: 'HONG KONG', // [UNVERIFIED]
  SG: 'SINGAPORE', // [UNVERIFIED]
  MY: 'MALAYSIA', // [UNVERIFIED]
  TH: 'THAILAND', // [UNVERIFIED]
  PH: 'PHILIPPINES', // [UNVERIFIED]
  ID: 'INDONESIA', // [UNVERIFIED]
  IN: 'INDIA', // [UNVERIFIED]
  PK: 'PAKISTAN', // [UNVERIFIED]
  BD: 'BANGLADESH', // [UNVERIFIED]
  LK: 'SRI LANKA', // [UNVERIFIED]
  AE: 'UNITED ARAB EMIRATES', // [UNVERIFIED]
  SA: 'SAUDI ARABIA', // [UNVERIFIED]
  QA: 'QATAR', // [UNVERIFIED]
  KW: 'KUWAIT', // [UNVERIFIED]
  BH: 'BAHRAIN', // [UNVERIFIED]
  OM: 'OMAN', // [UNVERIFIED]
  IL: 'ISRAEL', // [UNVERIFIED]
  TR: 'TURKEY', // [UNVERIFIED] — may be TURKIYE on a current list
};

/**
 * Codes we have positive evidence for. Used by nothing at runtime — it exists
 * so the distinction survives a future refactor that strips comments, and so a
 * reader can tell at a glance how much of this table is actually proven.
 */
export const VERIFIED_COUNTRY_CODES = new Set(['GB', 'GH']);

/**
 * The effective mapping: the built-in table, overridden and extended by
 * GARDNERS_COUNTRY_NAMES_EXTRA.
 *
 * Resolved once at module load rather than per call — this is configuration,
 * and it cannot change without a restart.
 */
const COUNTRY_NAMES: Record<string, string> = {
  ...BUILT_IN_COUNTRY_NAMES,
  ...config.commerce.gardnersCountryNamesExtra,
};

/** The Gardners country name for an ISO code, or null if we have no mapping. */
export function gardnersCountryName(isoCode: string): string | null {
  return COUNTRY_NAMES[isoCode.trim().toUpperCase()] ?? null;
}

/**
 * Whether an order to this country can be submitted at all.
 *
 * Checked at **checkout, before payment** — not at fulfilment. Discovering we
 * cannot address a parcel after the card has been charged means refunding an
 * order we were never able to ship, and a refund is currently a manual Stripe
 * action plus a phone call to Gardners.
 */
export function isDeliverableCountry(isoCode: string): boolean {
  return gardnersCountryName(isoCode) !== null;
}

/** Every ISO code we can currently address a parcel to. */
export function deliverableCountryCodes(): string[] {
  return Object.keys(COUNTRY_NAMES).sort();
}

// ── Delivery service codes ───────────────────────────────────────────────────

/**
 * Home Delivery service codes, transcribed from the I12 specification page 11
 * ("HOME DELIVERY SERVICE CODES"). All are three-digit numeric fields.
 *
 *   001  Standard UK Delivery — 2nd Class Post, two-day average.
 *        Tracked by default except Large Letter.
 *   002  Premium UK Delivery — 1st Class Post, next day if placed before 3pm.
 *   010  Airmail untracked — 5-7 days Western Europe, 7-10 elsewhere.
 *   011  Airmail Tracked — same timings, tracked to destination.
 *   015  BFPO — via London for onward shipping. Requires the BFPO number in
 *        the address or delivery cannot be made.
 *
 * An undocumented code is rejected per-line in the .ACK with
 * `"ERROR","SERVICE",070` / `<This is not a valid Service Code>` (page 15).
 */
export const GARDNERS_SERVICE_CODES = {
  ukStandard: '001',
  ukPremium: '002',
  overseasUntracked: '010',
  overseasTracked: '011',
  bfpo: '015',
} as const;

/**
 * The service code for a destination.
 *
 * UK gets 001 (Standard, 2nd Class); everywhere else gets 011 (Airmail
 * Tracked). Confirmed against the spec's table on page 11 and against real
 * traffic in both directions: the specification's own UK worked examples use
 * `"SERVICE",001`, and our accepted Ghana orders (000000043, 000000044) used
 * `"SERVICE",011`.
 *
 * BFPO (015) is deliberately not reachable here. It needs the BFPO number
 * inside the address and is a different address shape entirely, so it is a
 * feature rather than a branch — see the note in docs/ecommerce-plan.md.
 */
export function serviceCodeFor(isoCode: string): string {
  return isoCode.trim().toUpperCase() === 'GB'
    ? GARDNERS_SERVICE_CODES.ukStandard
    : GARDNERS_SERVICE_CODES.overseasTracked;
}

/**
 * Whether TRACKING,"Y" is meaningful for a service code.
 *
 * The spec is self-contradictory here and the resolution matters. Page 10 says
 * the tracking flag "is used in conjunction with the Service codes 001, 002,
 * 010 only". Page 11, describing 011 directly, says "Although this is already a
 * Tracked service, you will need to select 'TRACKING','Y' to allow the other
 * related TRACKED fields to be used."
 *
 * Page 11 wins, on two grounds: it is the more specific statement, and it
 * matches observed behaviour — our Ghana orders went out as `"SERVICE",011`
 * with `"TRACKING","Y"` and were acknowledged without an error, with Gardners
 * references issued.
 */
export function supportsTracking(serviceCode: string): boolean {
  return serviceCode !== GARDNERS_SERVICE_CODES.bfpo;
}
