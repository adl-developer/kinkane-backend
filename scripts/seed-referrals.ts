/**
 * Seeds (or removes) a random-looking referral network under one existing
 * account, so the referral screen, journey map and globe can be judged with
 * real spread.
 *
 *   npm run seed:referrals                               # under jason+1@authordigitallabs.com
 *   npm run seed:referrals -- --referrer someone@x.com   # under anyone else
 *   npm run seed:referrals -- --seed 7                   # a different random layout
 *   npm run seed:referrals -- --reset                    # remove everything this script created
 *
 * Twenty readers, every one of them somewhere below the root. The shape, the
 * cities, the signup dates and which few are still unverified (Pending) are all
 * random — but drawn from a fixed-seed generator, so the same --seed produces
 * the same network every time and a screenshot can be reproduced.
 *
 * Exactly one full circuit, and it is the root's: a fixed three-hop chain goes
 * out to two foreign continents and comes home. Every random placement is
 * checked against the real circuit rule first and rejected if it would close a
 * circuit for anyone else, so the root's score stays predictable.
 *
 * Signup's geo lookup is bypassed: each reader gets a country, city and
 * city-centroid coordinates from the pool below, which is exactly what the
 * globe plots. Attribution and crediting then go through the real services, so
 * depths, ancestor paths, snapshots and points are what production would write.
 *
 * If the referrer has no country yet (the norm while geo resolution is
 * unconfigured) they are placed in Accra, marked `country_source = 'seed'` so
 * --reset can undo it — without a home country every one of their direct
 * referrals scores nothing.
 *
 * **Never run this against production.** It refuses when NODE_ENV=production,
 * and every account it creates uses the reserved `.test` TLD (RFC 2606).
 */
import { and, eq, like, sql } from 'drizzle-orm';
import { db } from '../src/db';
import {
  users, userSubscriptions, notificationPreferences, referrals, referralPoints, countries,
} from '../src/db/schema';
import type { Continent } from '../src/db/schema';
import { referralsService } from '../src/services/referrals.service';
import { referralScoringService, findCircuitEarners } from '../src/services/referral-scoring.service';
import { config } from '../src/config';

/** Every seeded account carries this, so cleanup is exact rather than a guess. */
const SEED_DOMAIN = '@seed-referrals.kinkane.test';
const SEED_SOURCE = 'seed';
const DEFAULT_REFERRER = 'jason+1@authordigitallabs.com';

const READER_COUNT = 20;
/** Degrees below the root, counting the root's own referrals as 1. */
const MAX_DEGREE = 6;
/** Chance a random reader is referred by the root directly rather than someone below. */
const ROOT_ATTACH_CHANCE = 0.3;
const PENDING_CHANCE = 0.15;
const SPREAD_DAYS = 60;

const HOME = { country: 'GH', city: 'Accra', lat: 5.6037, lng: -0.187 };

interface City {
  city: string;
  country: string;
  lat: number;
  lng: number;
}

// Several countries appear twice on purpose, so same-country and
// same-continent awards turn up rather than everything scoring as cross-continent.
const CITIES: City[] = [
  { city: 'Kumasi', country: 'GH', lat: 6.6885, lng: -1.6244 },
  { city: 'Tamale', country: 'GH', lat: 9.4008, lng: -0.8393 },
  { city: 'Lagos', country: 'NG', lat: 6.5244, lng: 3.3792 },
  { city: 'Abuja', country: 'NG', lat: 9.0765, lng: 7.3986 },
  { city: 'Nairobi', country: 'KE', lat: -1.2921, lng: 36.8219 },
  { city: 'Johannesburg', country: 'ZA', lat: -26.2041, lng: 28.0473 },
  { city: 'Cape Town', country: 'ZA', lat: -33.9249, lng: 18.4241 },
  { city: 'Cairo', country: 'EG', lat: 30.0444, lng: 31.2357 },
  { city: 'Casablanca', country: 'MA', lat: 33.5731, lng: -7.5898 },
  { city: 'Kigali', country: 'RW', lat: -1.9441, lng: 30.0619 },
  { city: 'Addis Ababa', country: 'ET', lat: 8.9806, lng: 38.7578 },
  { city: 'Dakar', country: 'SN', lat: 14.7167, lng: -17.4677 },
  { city: 'London', country: 'GB', lat: 51.5072, lng: -0.1276 },
  { city: 'Manchester', country: 'GB', lat: 53.4808, lng: -2.2426 },
  { city: 'Paris', country: 'FR', lat: 48.8566, lng: 2.3522 },
  { city: 'Berlin', country: 'DE', lat: 52.52, lng: 13.405 },
  { city: 'Madrid', country: 'ES', lat: 40.4168, lng: -3.7038 },
  { city: 'Rome', country: 'IT', lat: 41.9028, lng: 12.4964 },
  { city: 'Amsterdam', country: 'NL', lat: 52.3676, lng: 4.9041 },
  { city: 'Lisbon', country: 'PT', lat: 38.7223, lng: -9.1393 },
  { city: 'Stockholm', country: 'SE', lat: 59.3293, lng: 18.0686 },
  { city: 'Dublin', country: 'IE', lat: 53.3498, lng: -6.2603 },
  { city: 'Mumbai', country: 'IN', lat: 19.076, lng: 72.8777 },
  { city: 'Delhi', country: 'IN', lat: 28.7041, lng: 77.1025 },
  { city: 'Tokyo', country: 'JP', lat: 35.6762, lng: 139.6503 },
  { city: 'Seoul', country: 'KR', lat: 37.5665, lng: 126.978 },
  { city: 'Singapore', country: 'SG', lat: 1.3521, lng: 103.8198 },
  { city: 'Dubai', country: 'AE', lat: 25.2048, lng: 55.2708 },
  { city: 'Manila', country: 'PH', lat: 14.5995, lng: 120.9842 },
  { city: 'Bangkok', country: 'TH', lat: 13.7563, lng: 100.5018 },
  { city: 'New York', country: 'US', lat: 40.7128, lng: -74.006 },
  { city: 'Los Angeles', country: 'US', lat: 34.0522, lng: -118.2437 },
  { city: 'Atlanta', country: 'US', lat: 33.749, lng: -84.388 },
  { city: 'Toronto', country: 'CA', lat: 43.6532, lng: -79.3832 },
  { city: 'Mexico City', country: 'MX', lat: 19.4326, lng: -99.1332 },
  { city: 'Kingston', country: 'JM', lat: 17.9712, lng: -76.7936 },
  { city: 'São Paulo', country: 'BR', lat: -23.5505, lng: -46.6333 },
  { city: 'Buenos Aires', country: 'AR', lat: -34.6037, lng: -58.3816 },
  { city: 'Bogotá', country: 'CO', lat: 4.711, lng: -74.0721 },
  { city: 'Lima', country: 'PE', lat: -12.0464, lng: -77.0428 },
  { city: 'Sydney', country: 'AU', lat: -33.8688, lng: 151.2093 },
  { city: 'Melbourne', country: 'AU', lat: -37.8136, lng: 144.9631 },
  { city: 'Auckland', country: 'NZ', lat: -36.8485, lng: 174.7633 },
];

const FIRST_NAMES = [
  'Ama', 'Kofi', 'Chidi', 'Wanjiru', 'Thandi', 'Yasmin', 'Oliver', 'Camille', 'Lukas', 'Sofia',
  'Arjun', 'Hana', 'Min-jun', 'Aiko', 'Priya', 'Emily', 'Marcus', 'Lucía', 'Mateo', 'Isla',
  'Noah', 'Zara', 'Kwame', 'Amara', 'Leila', 'Rafael', 'Ingrid', 'Tariq', 'Mei', 'Diego',
];
const LAST_NAMES = [
  'Owusu', 'Mensah', 'Okeke', 'Kamau', 'Nkosi', 'Haddad', 'Hughes', 'Laurent', 'Becker', 'Rossi',
  'Mehta', 'Sato', 'Kim', 'Tanaka', 'Nair', 'Carter', 'Brown', 'García', 'Almeida', 'Walker',
  'Silva', 'Ahmed', 'Boateng', 'Diallo', 'Novak', 'Costa', 'Lindqvist', 'Rahman', 'Chen', 'Torres',
];

/** mulberry32 — tiny, seedable, and plenty for picking cities. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PlannedReader {
  key: string;
  name: string;
  city: City;
  continent: Continent;
  /** Key of the reader who referred them; 'root' for the root referrer. */
  referredBy: string;
  degree: number;
  verified: boolean;
  /** Part of the fixed around-the-world chain. */
  circuit: boolean;
  signedUpAt?: Date;
}

/**
 * Lays the whole network out in memory before anything touches the database,
 * in insertion order — every reader's referrer comes before them.
 */
function planNetwork(
  rand: () => number,
  home: Continent,
  continentOf: Map<string, Continent>,
): PlannedReader[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const pool = CITIES.filter((c) => continentOf.has(c.country)).map((c) => ({
    ...c,
    continent: continentOf.get(c.country)!,
  }));
  const used = new Set<string>();
  const take = (candidates: typeof pool) => {
    const c = pick(candidates.filter((x) => !used.has(x.city)));
    used.add(c.city);
    return c;
  };

  // The circuit: out to two different foreign continents, then home. Their
  // positions in the signup order are random, but their order is kept.
  const foreign = [...new Set(pool.map((c) => c.continent))].filter((c) => c !== home);
  const out1 = pick(foreign);
  const out2 = pick(foreign.filter((c) => c !== out1));
  const circuitStops = [
    take(pool.filter((c) => c.continent === out1)),
    take(pool.filter((c) => c.continent === out2)),
    take(pool.filter((c) => c.continent === home)),
  ];
  const circuitSlots = new Set<number>();
  while (circuitSlots.size < circuitStops.length) circuitSlots.add(Math.floor(rand() * READER_COUNT));
  const slots = [...circuitSlots].sort((a, b) => a - b);

  const names = new Set<string>();
  const newName = () => {
    let n: string;
    do n = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    while (names.has(n));
    names.add(n);
    return n;
  };

  const plan: PlannedReader[] = [];
  const byKey = new Map<string, PlannedReader>();

  // Continents from the root down to (and including) this reader — the path
  // findCircuitEarners walks. 'root' stands in for the root's own id.
  const pathTo = (key: string): { userId: number; continent: Continent }[] => {
    const chain: { userId: number; continent: Continent }[] = [];
    for (let k = key; k !== 'root'; k = byKey.get(k)!.referredBy) {
      chain.unshift({ userId: plan.indexOf(byKey.get(k)!) + 1, continent: byKey.get(k)!.continent });
    }
    return [{ userId: 0, continent: home }, ...chain];
  };

  let circuitParent = 'root';
  for (let i = 0; i < READER_COUNT; i++) {
    const key = `reader-${String(i + 1).padStart(2, '0')}`;
    const ci = slots.indexOf(i);

    if (ci >= 0) {
      const stop = circuitStops[ci];
      const parentDegree = circuitParent === 'root' ? 0 : byKey.get(circuitParent)!.degree;
      const r: PlannedReader = {
        key, name: newName(), city: stop, continent: stop.continent,
        referredBy: circuitParent, degree: parentDegree + 1, verified: true, circuit: true,
      };
      plan.push(r);
      byKey.set(key, r);
      circuitParent = key;
      continue;
    }

    // A random parent and city, retried until the placement cannot close a
    // circuit for anyone. The root is exempt: its circuit is once per season,
    // so a second one is a no-op in the ledger rather than extra points.
    // Pending readers are never parents — an unverified account passing its
    // link on is possible, but not the picture this seed is meant to show.
    for (let attempt = 0; ; attempt++) {
      if (attempt > 500) throw new Error('Could not place a reader without closing a stray circuit');
      const parents = plan.filter((p) => p.verified && p.degree < MAX_DEGREE);
      const parentKey = parents.length === 0 || rand() < ROOT_ATTACH_CHANCE ? 'root' : pick(parents).key;
      const city = pick(pool.filter((c) => !used.has(c.city)));

      const earners = findCircuitEarners(parentKey === 'root' ? [{ userId: 0, continent: home }] : pathTo(parentKey), city.continent);
      if (earners.some((id) => id !== 0)) continue;

      used.add(city.city);
      const r: PlannedReader = {
        key, name: newName(), city, continent: city.continent,
        referredBy: parentKey,
        degree: parentKey === 'root' ? 1 : byKey.get(parentKey)!.degree + 1,
        verified: rand() >= PENDING_CHANCE,
        circuit: false,
      };
      plan.push(r);
      byKey.set(key, r);
      break;
    }
  }

  // Random dates, sorted, handed out in insertion order — so every reader
  // signed up after the person who referred them.
  const dates = Array.from({ length: READER_COUNT }, () => Date.now() - (1 + rand() * (SPREAD_DAYS - 1)) * 86_400_000)
    .sort((a, b) => a - b);
  plan.forEach((r, i) => (r.signedUpAt = new Date(dates[i])));

  return plan;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function findReferrer(email: string): Promise<{ id: number; name: string; countryCode: string | null }> {
  const [row] = await db
    .select({ id: users.id, name: users.name, countryCode: users.countryCode })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!row) {
    console.error(`No account for ${email} in this database. Pass --referrer <email> or point DATABASE_URL elsewhere.`);
    process.exit(1);
  }
  return row;
}

async function reset(referrerEmail: string): Promise<void> {
  const seeded = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${SEED_DOMAIN}`));

  // Referrals, codes and every point that references a seeded referral cascade
  // from the user rows.
  await db.delete(users).where(like(users.email, `%${SEED_DOMAIN}`));

  const [root] = await db
    .select({ id: users.id, countrySource: users.countrySource })
    .from(users)
    .where(eq(users.email, referrerEmail.toLowerCase()))
    .limit(1);

  if (root) {
    // Circuit rows carry no referral_id, so nothing cascades them. Only drop the
    // root's circuit when nothing is left below them that could have earned it.
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(referrals)
      .where(sql`${referrals.ancestorPath} @> ARRAY[${root.id}]::integer[]`);
    if (left.n === 0) {
      await db
        .delete(referralPoints)
        .where(and(eq(referralPoints.userId, root.id), eq(referralPoints.kind, 'full_circuit')));
    }

    if (root.countrySource === SEED_SOURCE) {
      await db
        .update(users)
        .set({
          countryCode: null, countrySource: 'unknown', countryResolvedAt: null,
          city: null, cityLat: null, cityLng: null, citySource: null,
        })
        .where(eq(users.id, root.id));
      console.log(`Cleared the seeded home location on ${referrerEmail}.`);
    }
  }

  console.log(`Removed ${seeded.length} seeded readers and their referrals and points.`);
}

async function seed(referrerEmail: string, seedValue: number): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${SEED_DOMAIN}`));
  if (existing.length > 0) {
    console.log(`${existing.length} seeded readers already exist. Run with --reset first.`);
    process.exit(1);
  }

  const root = await findReferrer(referrerEmail);

  let homeCountry = root.countryCode;
  if (!homeCountry) {
    await db
      .update(users)
      .set({
        countryCode: HOME.country, countrySource: SEED_SOURCE, countryResolvedAt: new Date(),
        city: HOME.city, cityLat: HOME.lat, cityLng: HOME.lng, citySource: SEED_SOURCE,
      })
      .where(eq(users.id, root.id));
    homeCountry = HOME.country;
    console.log(`${root.name} had no country — placed in ${HOME.city}, ${HOME.country}.`);
  }

  const continentOf = new Map(
    (await db.select({ code: countries.code, continent: countries.continent }).from(countries))
      .map((c) => [c.code, c.continent]),
  );
  const home = continentOf.get(homeCountry);
  if (!home) {
    console.error(`${root.name}'s country ${homeCountry} has no continent — a circuit is impossible.`);
    process.exit(1);
  }

  const plan = planNetwork(rng(seedValue), home, continentOf);
  const ids = new Map<string, number>([['root', root.id]]);
  const names = new Map<string, string>([['root', root.name]]);
  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  console.log(`\nSeed ${seedValue}:`);
  for (const r of plan) {
    const referrerId = ids.get(r.referredBy)!;
    const { code } = await referralsService.getOrCreateCode(referrerId);
    const signedUpAt = r.signedUpAt!;
    const email = r.key + SEED_DOMAIN;

    // Same shape as authService.signup: user, subscription, preferences and the
    // attribution edge commit together.
    const userId = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          name: r.name,
          email,
          emailVerified: r.verified,
          countryCode: r.city.country,
          countrySource: SEED_SOURCE,
          countryResolvedAt: signedUpAt,
          city: r.city.city,
          cityLat: r.city.lat,
          cityLng: r.city.lng,
          citySource: SEED_SOURCE,
          createdAt: signedUpAt,
        })
        .returning({ id: users.id });
      await tx.insert(userSubscriptions).values({ userId: u.id, tier: 'plus', status: 'trialing', trialEndsAt });
      await tx.insert(notificationPreferences).values({ userId: u.id });

      const referral = await referralsService.attributeSignup(tx, {
        referredUserId: u.id,
        code,
        redeemerCountry: r.city.country,
        redeemerCity: r.city.city,
        channel: 'whatsapp',
      });
      if (!referral) throw new Error(`Attribution failed for ${email}`);
      await tx.update(referrals).set({ signedUpAt }).where(eq(referrals.id, referral.id));

      return u.id;
    });
    ids.set(r.key, userId);
    names.set(r.key, r.name);

    // Verification is what credits a referral, and circuits are checked after —
    // exactly the order creditReferralInBackground runs them in.
    if (r.verified) {
      await referralsService.creditVerifiedSignup(userId);
      await referralScoringService.detectCircuits(userId);
      await db
        .update(referrals)
        .set({ creditedAt: new Date(signedUpAt.getTime() + 60 * 60 * 1000) })
        .where(eq(referrals.referredUserId, userId));
    }

    const flags = [r.circuit && 'circuit', !r.verified && 'pending'].filter(Boolean).join(', ');
    console.log(
      `  ${String(r.degree).padStart(2)}°  ${r.name.padEnd(18)} ${`${r.city.city}, ${r.city.country}`.padEnd(20)}` +
        ` via ${names.get(r.referredBy)!.padEnd(18)}${flags ? ` (${flags})` : ''}`,
    );
  }

  const score = await referralScoringService.scoreFor(root.id);
  const circuitEarners = await db
    .select({ userId: referralPoints.userId })
    .from(referralPoints)
    .where(and(eq(referralPoints.kind, 'full_circuit'), sql`${referralPoints.userId} in (${sql.join([...ids.values()], sql`, `)})`));

  console.log(`\n${root.name} now has ${plan.length} readers in their network and ${score.total} points.`);
  console.log(`Circuits in this network: ${circuitEarners.length} (${circuitEarners.every((c) => c.userId === root.id) ? `all ${root.name}'s` : 'NOT all the root’s'}).`);
  console.log('Run with --reset to remove all of it.');
}

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('Refusing to run: NODE_ENV is production.');
    process.exit(1);
  }
  const referrer = argValue('--referrer') ?? DEFAULT_REFERRER;
  const seedValue = Number(argValue('--seed') ?? 1);
  if (!Number.isInteger(seedValue)) {
    console.error('--seed must be an integer.');
    process.exit(1);
  }
  await (process.argv.includes('--reset') ? reset(referrer) : seed(referrer, seedValue));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', (err as Error).message);
  process.exit(1);
});
