import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { referrals, referralPoints, users, countries } from '../db/schema';
import type { Continent, ReferralPointKind } from '../db/schema';
import { geoService } from './geo.service';
import { logger } from '../lib/logger';

/**
 * The "Around the World" competition scoring.
 *
 * Kept separate from referrals.service on purpose: that one owns *who referred
 * whom*, which is a fact. This one owns *what that is worth*, which is a rule,
 * and rules change. Nothing here is allowed to fail a signup — attribution is
 * the durable record, points are derived from it and can always be recomputed.
 *
 * The pure functions at the top hold every scoring decision. They take plain
 * data and return plain data specifically so the rules can be tested exhaustively
 * without a database, since the interesting cases (an unknown continent halfway
 * up a chain, a circuit that closes six levels down) are miserable to set up as
 * fixtures and trivial to express as arrays.
 */

export const POINTS: Record<ReferralPointKind, number> = {
  same_country: 1,
  same_continent: 10,
  cross_continent: 20,
  // Second degree — a friend of a friend. Half the direct award, and paid only
  // for geographic spread: see scoreIndirectReferral.
  indirect_same_continent: 5,
  indirect_cross_continent: 10,
  full_circuit: 30,
};

/** Depth beyond which a chain stops being recorded as connected. */
export const MAX_DEPTH = 20;

/**
 * How far above a redemption the points still reach.
 *
 * 1 = the direct referrer, 2 = one person removed. "Beyond 1 person removed,
 * you can't earn any other points through that branch" — so a redemption pays
 * the referrer and the referrer's referrer, and nobody higher.
 *
 * This bound is what stops an early user's score compounding forever off a tree
 * they long ago stopped contributing to. Circuits are the deliberate exception:
 * they walk the whole chain, however deep.
 */
export const MAX_SCORING_GENERATIONS = 2;

/**
 * How many *distinct foreign* continents a path must touch before returning
 * home to count as a circuit.
 *
 * Two, not one: "went as far as at least two continents outside of yours and
 * back to the continent you're on". Note the supplied dev note still describes
 * the one-continent version ("their referrals touched another continent") —
 * confirmed 2026-08-10 that the two-continent bullet is the intended rule and
 * the dev note is stale.
 */
export const CIRCUIT_CONTINENTS_REQUIRED = 2;

/**
 * How each ledger kind is named in JSON.
 *
 * The Postgres enum stays snake_case — idiomatic for the database, and what
 * every migration and query already reads. The API is camelCase, like every
 * other response this server returns. Both conventions are right in their own
 * layer, so the translation happens here, once, rather than by renaming the
 * enum or by leaving `same_country` sitting in a response body next to
 * `hasCircuit`.
 *
 * `satisfies` is doing real work: it forces this map to cover every enum
 * member, so adding a point kind without giving it a JSON name fails the build
 * instead of silently returning an object with a missing key.
 */
export const POINT_KIND_JSON = {
  same_country: 'sameCountry',
  same_continent: 'sameContinent',
  cross_continent: 'crossContinent',
  indirect_same_continent: 'indirectSameContinent',
  indirect_cross_continent: 'indirectCrossContinent',
  full_circuit: 'fullCircuit',
} as const satisfies Record<ReferralPointKind, string>;

/** The `pointsByKind` object as clients receive it. */
export type PointsByKind = Record<(typeof POINT_KIND_JSON)[ReferralPointKind], number>;

export interface GeoPoint {
  country: string | null;
  continent: Continent | null;
}

// ── Rule 1: what a single direct referral is worth ────────────────────────────

/**
 * Points for one redemption, scored referrer-vs-redeemer.
 *
 * Returns null when either side's continent is unknown. That is the deliberate
 * treatment of unresolvable geography throughout: unknown scores nothing and is
 * never a wildcard. Note this also zeroes the case where both countries are
 * known and identical but the continent isn't — being in the same unplaceable
 * country still leaves the pair outside the competition, and letting it pay 1
 * point would make an unresolvable country marginally *profitable* to have.
 */
export function scoreDirectReferral(
  referrer: GeoPoint,
  redeemer: GeoPoint,
): { kind: ReferralPointKind; points: number } | null {
  if (!referrer.continent || !redeemer.continent) return null;

  if (referrer.continent !== redeemer.continent) {
    return { kind: 'cross_continent', points: POINTS.cross_continent };
  }

  // Same continent from here. Countries are known whenever a continent is —
  // a continent is only ever derived from a country code — so the remaining
  // split is safe.
  if (referrer.country && redeemer.country && referrer.country === redeemer.country) {
    return { kind: 'same_country', points: POINTS.same_country };
  }

  return { kind: 'same_continent', points: POINTS.same_continent };
}

// ── Rule 2: what a second-degree referral is worth ────────────────────────────

/**
 * Points for a redemption one person removed — Tom referred Ama, Ama referred
 * Lisa, this is what Tom earns for Lisa.
 *
 * Two things about this are easy to get wrong and both were confirmed
 * explicitly:
 *
 * 1. **Geography is measured against the earner, not the middle person.** Lisa
 *    is compared to Tom, not to Ama. The points are Tom's, so they describe how
 *    far *Tom's* network reached; Ama separately earns her own direct award for
 *    Lisa. Comparing to Ama would pay Tom 10 for two foreign countries that are
 *    both distant from him but adjacent to each other.
 * 2. **A second-degree signup in the earner's own country is worth nothing.**
 *    The rules list 5 (another country, same continent) and 10 (another
 *    continent) and stop there. The second degree pays for spread only — a
 *    domestic friend-of-a-friend earns nothing, which is what keeps a purely
 *    local tree from paying its root forever.
 */
export function scoreIndirectReferral(
  earner: GeoPoint,
  redeemer: GeoPoint,
): { kind: ReferralPointKind; points: number } | null {
  if (!earner.continent || !redeemer.continent) return null;

  if (earner.continent !== redeemer.continent) {
    return { kind: 'indirect_cross_continent', points: POINTS.indirect_cross_continent };
  }

  if (earner.country && redeemer.country && earner.country === redeemer.country) {
    return null;
  }

  return { kind: 'indirect_same_continent', points: POINTS.indirect_same_continent };
}

// ── Rule 2: who just completed a circuit ──────────────────────────────────────

export interface PathNode {
  userId: number;
  continent: Continent | null;
}

/**
 * Given the ancestor chain of a brand-new redeemer (root first, ending at their
 * direct referrer) and that redeemer's own continent, returns the ancestors who
 * have just closed an "around the world" circuit.
 *
 * An ancestor A earns a circuit when the redeemer N is back on A's continent
 * *and* the chain between them touched at least CIRCUIT_CONTINENTS_REQUIRED
 * distinct continents that are not A's:
 *
 *     A(AF) → x(EU) → y(AS) → N(AF)     A scores — two foreign continents, home again
 *     A(AF) → x(EU) → y(EU) → N(AF)     no — only one foreign continent (Europe twice)
 *     A(AF) → x(AF) → N(AF)             no — never left
 *     A(AF) → x(EU) → y(AS) → N(AS)     no — left twice over, didn't come back
 *
 * Note the second line: repeatedly hopping between two countries of the same
 * foreign continent is not a journey around the world, so continents are
 * counted **distinct**, not as visits.
 *
 * Computed with a single backward pass building a suffix count of distinct
 * foreign continents, rather than rescanning the tail for every candidate
 * ancestor. Every ancestor here is being tested against the same continent (the
 * redeemer's), so one suffix table serves all of them.
 *
 * Unknown continents on the path count for nothing — an unresolvable ancestor
 * must not be able to manufacture a circuit that a known one wouldn't.
 */
export function findCircuitEarners(path: PathNode[], redeemerContinent: Continent | null): number[] {
  if (!redeemerContinent) return [];

  // foreignAfter[i] = how many distinct non-home continents appear in path[i..].
  // Built from the end so each position sees everything below it.
  const foreignAfter = new Array<number>(path.length + 1).fill(0);
  const seen = new Set<Continent>();
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i].continent;
    if (c && c !== redeemerContinent) seen.add(c);
    foreignAfter[i] = seen.size;
  }

  const earners: number[] = [];
  for (let i = 0; i < path.length; i++) {
    // Strictly below this ancestor — an ancestor's own continent is home by
    // definition and can't count towards its own journey.
    if (path[i].continent === redeemerContinent && foreignAfter[i + 1] >= CIRCUIT_CONTINENTS_REQUIRED) {
      earners.push(path[i].userId);
    }
  }
  return earners;
}

// ── Persistence ───────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function geoFor(country: string | null): Promise<GeoPoint> {
  return { country, continent: await geoService.continentOf(country) };
}

export const referralScoringService = {
  scoreDirectReferral,
  scoreIndirectReferral,
  findCircuitEarners,

  /**
   * Writes the awards a redemption generates: the direct one for the referrer,
   * and the second-degree one for the referrer's own referrer. Called inside the
   * signup transaction, alongside the referral row itself, because points count
   * at redemption.
   *
   * onConflictDoNothing against the (referral_id, kind) unique index makes a
   * retry a no-op rather than a double payment.
   */
  async awardDirect(
    tx: Tx,
    params: {
      referralId: number;
      referrerUserId: number;
      referrerCountry: string | null;
      redeemerCountry: string | null;
      /** One person removed — the referrer's own referrer, if they have one. */
      grandReferrerUserId?: number | null;
      grandReferrerCountry?: string | null;
    },
  ): Promise<void> {
    const [referrer, redeemer, grand] = await Promise.all([
      geoFor(params.referrerCountry),
      geoFor(params.redeemerCountry),
      geoFor(params.grandReferrerCountry ?? null),
    ]);

    const rows: (typeof referralPoints.$inferInsert)[] = [];

    const direct = scoreDirectReferral(referrer, redeemer);
    if (direct) {
      rows.push({
        userId: params.referrerUserId,
        referralId: params.referralId,
        kind: direct.kind,
        points: direct.points,
      });
    }

    // Second degree. Scored against the grandparent's own geography, not the
    // referrer's — the points are theirs, so they describe how far *their*
    // network reached.
    //
    // Nothing beyond this generation: "beyond 1 person removed, you can't earn
    // any other points through that branch". The great-grandparent and above are
    // deliberately not looked up at all.
    if (params.grandReferrerUserId) {
      const indirect = scoreIndirectReferral(grand, redeemer);
      if (indirect) {
        rows.push({
          userId: params.grandReferrerUserId,
          referralId: params.referralId,
          kind: indirect.kind,
          points: indirect.points,
        });
      }
    }

    if (rows.length === 0) return;

    // Both rows share a referral_id and differ only by kind, which is exactly
    // what the (referral_id, kind) unique index is keyed on — so a retry is a
    // no-op for each independently.
    await tx.insert(referralPoints).values(rows).onConflictDoNothing();
  },

  /**
   * Detects and awards circuits for a newly redeemed referral.
   *
   * Runs *after* the signup transaction commits, deliberately. It reads and
   * writes rows belonging to users far outside the one signing up, and no
   * scoring bug should ever be able to stop an account being created. The unique
   * constraints on the ledger are what make re-running it safe.
   */
  async detectCircuits(referredUserId: number): Promise<number[]> {
    const [row] = await db
      .select({
        ancestorPath: referrals.ancestorPath,
        redeemerCountry: referrals.redeemerCountry,
      })
      .from(referrals)
      .where(and(eq(referrals.referredUserId, referredUserId), eq(referrals.status, 'active')))
      .limit(1);

    if (!row || row.ancestorPath.length === 0) return [];

    const redeemerContinent = await geoService.continentOf(row.redeemerCountry);
    if (!redeemerContinent) return [];

    // One read for every ancestor's country. LEFT JOIN: an ancestor whose
    // country never resolved still has to occupy its position in the chain,
    // because dropping it would silently shorten the path and could turn a
    // non-circuit into a circuit.
    const ancestors = await db
      .select({ id: users.id, continent: countries.continent })
      .from(users)
      .leftJoin(countries, eq(users.countryCode, countries.code))
      .where(inArray(users.id, row.ancestorPath));

    const continentById = new Map(ancestors.map((a) => [a.id, a.continent]));
    const path: PathNode[] = row.ancestorPath.map((userId) => ({
      userId,
      continent: continentById.get(userId) ?? null,
    }));

    const earners = findCircuitEarners(path, redeemerContinent);
    if (earners.length === 0) return [];

    await db
      .insert(referralPoints)
      .values(
        earners.map((userId) => ({
          userId,
          referralId: null,
          kind: 'full_circuit' as const,
          points: POINTS.full_circuit,
        })),
      )
      // Circuits are once per user per season — the partial unique index is the
      // enforcement, this just makes hitting it a no-op.
      .onConflictDoNothing();

    logger.info('Referral circuit(s) completed', { referredUserId, earners });
    return earners;
  },

  /** A user's current score, broken down by how it was earned. */
  async scoreFor(userId: number): Promise<{
    total: number;
    byKind: PointsByKind;
    hasCircuit: boolean;
  }> {
    const rows = await db
      .select({
        kind: referralPoints.kind,
        points: sql<number>`sum(${referralPoints.points})::int`,
      })
      .from(referralPoints)
      .where(and(eq(referralPoints.userId, userId), eq(referralPoints.state, 'counted')))
      .groupBy(referralPoints.kind);

    // Every kind present and zeroed, so a client can render the full breakdown
    // without special-casing absent keys.
    const byKind = Object.fromEntries(
      Object.values(POINT_KIND_JSON).map((key) => [key, 0]),
    ) as PointsByKind;

    for (const r of rows) byKind[POINT_KIND_JSON[r.kind]] = r.points;

    return {
      total: Object.values(byKind).reduce((a, b) => a + b, 0),
      byKind,
      hasCircuit: byKind.fullCircuit > 0,
    };
  },

  /**
   * Competition standings. Country comes along because it is the whole point of
   * this leaderboard; nothing else identifying does.
   */
  async leaderboard(limit = 50): Promise<
    { userId: number; name: string; countryCode: string | null; points: number }[]
  > {
    return db
      .select({
        userId: referralPoints.userId,
        name: users.name,
        countryCode: users.countryCode,
        points: sql<number>`sum(${referralPoints.points})::int`,
      })
      .from(referralPoints)
      .innerJoin(users, eq(users.id, referralPoints.userId))
      .where(eq(referralPoints.state, 'counted'))
      .groupBy(referralPoints.userId, users.name, users.countryCode)
      .orderBy(sql`sum(${referralPoints.points}) desc`)
      .limit(limit);
  },

  /**
   * Voids a referral and every point it produced.
   *
   * Circuit awards are deliberately left alone. A circuit is earned by a path,
   * not by any one referral, and recomputing which circuits would still stand
   * without this edge means re-walking every affected subtree — real work, for a
   * correction that is rare and manual. The honest position is that voiding
   * removes the direct award and leaves a circuit that may now be unearned;
   * anyone acting on this should know that rather than assume a full unwind.
   */
  async voidReferral(referralId: number, reason: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(referrals)
        .set({ status: 'voided', voidedAt: new Date(), voidReason: reason })
        .where(eq(referrals.id, referralId));

      await tx
        .update(referralPoints)
        .set({ state: 'voided', voidedAt: new Date(), voidReason: reason })
        .where(eq(referralPoints.referralId, referralId));
    });

    logger.info('Referral voided', { referralId, reason });
  },
};
