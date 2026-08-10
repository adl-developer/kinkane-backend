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
  full_circuit: 30,
};

/** Depth beyond which a chain stops being recorded as connected. */
export const MAX_DEPTH = 20;

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
 * *and* the chain between them left that continent at some point:
 *
 *     A(AF) → x(EU) → y(EU) → N(AF)     A scores — left Africa, came back
 *     A(AF) → x(AF) → N(AF)             no — never left
 *     A(AF) → x(EU) → N(EU)             no — left, didn't come back
 *
 * The scan is linear rather than the obvious nested loop: "is there a differing
 * continent later in the chain" is monotone in position, so the last index
 * holding a different continent decides it for every ancestor before it.
 *
 * Unknown continents on the path are not treated as "different" — an
 * unresolvable ancestor must not be able to manufacture a circuit that a known
 * one wouldn't.
 */
export function findCircuitEarners(path: PathNode[], redeemerContinent: Continent | null): number[] {
  if (!redeemerContinent) return [];

  let lastDifferent = -1;
  for (let i = 0; i < path.length; i++) {
    const c = path[i].continent;
    if (c && c !== redeemerContinent) lastDifferent = i;
  }

  if (lastDifferent < 0) return [];

  const earners: number[] = [];
  for (let i = 0; i < lastDifferent; i++) {
    if (path[i].continent === redeemerContinent) earners.push(path[i].userId);
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
  findCircuitEarners,

  /**
   * Writes the direct award for a referral. Called inside the signup
   * transaction, alongside the referral row itself, because points count at
   * redemption.
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
    },
  ): Promise<void> {
    const [referrer, redeemer] = await Promise.all([
      geoFor(params.referrerCountry),
      geoFor(params.redeemerCountry),
    ]);

    const award = scoreDirectReferral(referrer, redeemer);
    if (!award) return;

    await tx
      .insert(referralPoints)
      .values({
        userId: params.referrerUserId,
        referralId: params.referralId,
        kind: award.kind,
        points: award.points,
      })
      .onConflictDoNothing();
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
    byKind: Record<ReferralPointKind, number>;
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

    const byKind: Record<ReferralPointKind, number> = {
      same_country: 0,
      same_continent: 0,
      cross_continent: 0,
      full_circuit: 0,
    };
    for (const r of rows) byKind[r.kind] = r.points;

    return {
      total: Object.values(byKind).reduce((a, b) => a + b, 0),
      byKind,
      hasCircuit: byKind.full_circuit > 0,
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
