import type { Request } from 'express';
import { db } from '../db';
import { countries } from '../db/schema';
import type { Continent } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { normalizeCountryCode } from '../lib/country';

/**
 * "Where in the world is this request coming from?"
 *
 * Everything the referral competition pays out on rests on this answer, and the
 * answer is never certain — a VPN defeats IP geolocation, which is exactly what
 * someone would use to manufacture the 20-point cross-continent award. With no
 * prizes attached that exposure is accepted deliberately; see
 * docs/referral-system-plan.md. What this service owes the rest of the system is
 * therefore honesty rather than confidence: it reports *how* it knows, and
 * returns `unknown` rather than a guess.
 *
 * Country is resolved once, at signup, and then frozen on the user row. It is
 * never re-derived on later requests: someone travelling must not silently
 * change continent mid-competition.
 */

export type CountrySource = 'header' | 'maxmind' | 'admin' | 'unknown';

export interface ResolvedCountry {
  code: string | null;
  source: CountrySource;
}

const UNKNOWN: ResolvedCountry = { code: null, source: 'unknown' };

// ── Country → continent lookup ────────────────────────────────────────────────
// ~250 rows that change only when the seed is re-run, read on every scoring
// decision. Held in memory rather than joined per query; a miss re-reads the
// table once rather than per lookup.

let continentByCountry: Map<string, Continent> | null = null;
let loading: Promise<Map<string, Continent>> | null = null;

async function loadContinents(): Promise<Map<string, Continent>> {
  if (continentByCountry) return continentByCountry;
  // Concurrent callers during startup share one query instead of racing to run
  // the same SELECT several times.
  if (loading) return loading;

  loading = db
    .select({ code: countries.code, continent: countries.continent })
    .from(countries)
    .then((rows) => {
      const map = new Map(rows.map((r) => [r.code.toUpperCase(), r.continent]));
      continentByCountry = map;
      loading = null;
      if (map.size === 0) {
        // Not fatal — scoring degrades to "everything is unknown, nothing
        // scores" — but it means `npm run db:init` never seeded, and every
        // referral from here on is worth zero points. Worth shouting about.
        logger.warn('Country table is empty — referral scoring will award no points until it is seeded');
      }
      return map;
    })
    .catch((err: Error) => {
      loading = null;
      logger.error('Failed to load country/continent reference data', { error: err.message });
      throw err;
    });

  return loading;
}

// ── MaxMind ───────────────────────────────────────────────────────────────────
// Optional: the `maxmind` package and a GeoLite2 country database on disk are
// both things a deployment may not have. Loaded through a dynamic import so a
// missing package is a logged degradation rather than a boot failure — this
// server has to run in CI and locally without a licensed geo database.

interface MaxmindReader {
  get(ip: string): { country?: { iso_code?: string } } | null;
}

let maxmindReader: MaxmindReader | null = null;
let maxmindTried = false;

async function getMaxmindReader(): Promise<MaxmindReader | null> {
  if (maxmindTried) return maxmindReader;
  maxmindTried = true;

  if (!config.referrals.maxmindDbPath) return null;

  try {
    // The specifier is held in a variable on purpose. `maxmind` is an optional
    // dependency that most environments (CI, local development, any deployment
    // without a licensed GeoLite2 database) will not have installed, and a
    // literal import would make TypeScript demand the types at compile time —
    // turning an intentional runtime degradation into a build failure.
    const specifier = 'maxmind';
    const maxmind = (await import(specifier)) as { open: (path: string) => Promise<MaxmindReader> };
    maxmindReader = await maxmind.open(config.referrals.maxmindDbPath);
    logger.info('MaxMind geo database loaded', { path: config.referrals.maxmindDbPath });
  } catch (err) {
    logger.warn('MaxMind lookup unavailable — falling back to header/unknown', {
      path: config.referrals.maxmindDbPath,
      error: (err as Error).message,
    });
    maxmindReader = null;
  }

  return maxmindReader;
}

// Shared with commerce pricing — see lib/country for why this is one function.
const normalizeCode = normalizeCountryCode;

export const geoService = {
  /**
   * Resolves the country for an inbound request. Never throws — a geo failure
   * must not be able to fail a signup.
   */
  async resolveFromRequest(req: Request): Promise<ResolvedCountry> {
    // 1. Trusted proxy header. Only consulted when GEO_COUNTRY_HEADER names one,
    //    because any client can set any header: trusting one while the origin is
    //    reachable directly would hand users a free country picker.
    const headerName = config.referrals.countryHeader;
    if (headerName) {
      const raw = req.headers[headerName];
      const code = normalizeCode(Array.isArray(raw) ? raw[0] : raw);
      if (code) return { code, source: 'header' };
    }

    // 2. Local MaxMind database.
    const ip = req.ip;
    if (ip) {
      try {
        const reader = await getMaxmindReader();
        const code = normalizeCode(reader?.get(ip)?.country?.iso_code);
        if (code) return { code, source: 'maxmind' };
      } catch (err) {
        logger.warn('MaxMind lookup failed', { error: (err as Error).message });
      }
    }

    return UNKNOWN;
  },

  /**
   * Continent for a country code, or null when the code is unknown to us —
   * which covers Antarctica, user-assigned codes, and anything the seed
   * predates. Null means "scores nothing", never "assume something".
   */
  async continentOf(code: string | null | undefined): Promise<Continent | null> {
    if (!code) return null;
    try {
      const map = await loadContinents();
      return map.get(code.toUpperCase()) ?? null;
    } catch {
      // Already logged in loadContinents. Degrade to unknown rather than
      // failing the caller: a referral that scores nothing is recoverable, a
      // failed signup is not.
      return null;
    }
  },

  /** Continents for several countries at once — one map read, no extra queries. */
  async continentsOf(codes: (string | null | undefined)[]): Promise<Map<string, Continent>> {
    const result = new Map<string, Continent>();
    try {
      const map = await loadContinents();
      for (const code of codes) {
        if (!code) continue;
        const upper = code.toUpperCase();
        const continent = map.get(upper);
        if (continent) result.set(upper, continent);
      }
    } catch {
      // Same reasoning as continentOf — an empty map scores nothing.
    }
    return result;
  },

  /** Test seam: drops the cached reference data so a reseed is picked up. */
  resetCache(): void {
    continentByCountry = null;
    loading = null;
    maxmindReader = null;
    maxmindTried = false;
  },
};
