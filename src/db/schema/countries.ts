import { pgTable, char, varchar, pgEnum, index } from 'drizzle-orm/pg-core';

// ── Continents ─────────────────────────────────────────────────────────────────
// Only the six habitable continents exist here, because the referral competition
// is defined over exactly those. Antarctica is not a value: a user who somehow
// geolocates to AQ has no continent, which the scoring rules already handle as
// "unknown, worth nothing" — the alternative would be an enum member that every
// scoring branch has to remember to exclude.

export const continentEnum = pgEnum('continent', [
  'AF', // Africa
  'EU', // Europe
  'AS', // Asia
  'NA', // North America
  'SA', // South America
  'OC', // Australia & Oceania
]);

// ── Countries ──────────────────────────────────────────────────────────────────
// ISO 3166-1 alpha-2, seeded once from src/db/seeds/countries.ts. Reference data:
// read on every scoring decision, written only by the seed.
//
// Deliberately NOT referenced by a foreign key from users.country_code. A geo
// lookup can legitimately return a code this table doesn't carry — AQ, or a
// user-assigned code like XK for Kosovo — and under an FK that would abort the
// signup transaction. An account must never fail to be created because we can't
// place it on a map. Unresolvable codes are stored as-is and simply score
// nothing; the join that reads them is a LEFT JOIN.

export const countries = pgTable(
  'countries',
  {
    code: char('code', { length: 2 }).primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    continent: continentEnum('continent').notNull(),
  },
  (t) => ({
    continentIdx: index('idx_countries_continent').on(t.continent),
  }),
);

export type Continent = (typeof continentEnum.enumValues)[number];
export type Country = typeof countries.$inferSelect;
