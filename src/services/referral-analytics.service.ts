import { sql, eq, and, gte, isNotNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { referrals, referralInvites, users, countries } from '../db/schema';

/**
 * Campaign-wide figures for the Analytics screen.
 *
 * Public, like the leaderboard, and shaped by that: every number here is an
 * aggregate over the whole campaign and nothing in a response can be traced
 * back to an individual. The one place a person appears is the top-referrer
 * list, which carries a first name and a country — exactly what the public
 * leaderboard already shows, and no more.
 *
 * Kept out of referrals.service because that file owns one user's facts. These
 * are the campaign's, they are read by anonymous callers, and they are the only
 * queries in the feature that scan the whole table rather than one user's slice.
 */

/** How many weekly buckets the two charts show. */
export const CHART_WEEKS = 8;

/** Monday 00:00 UTC of the week that starts the chart window. */
export function windowStart(weeks = CHART_WEEKS): Date {
  const now = new Date();
  // date_trunc('week') in Postgres is Monday-based, so the JS side has to match
  // or the first bucket would be half-width and always read as a slump.
  const day = (now.getUTCDay() + 6) % 7;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day);
  return new Date(monday - (weeks - 1) * 7 * 24 * 60 * 60 * 1000);
}

/**
 * Fills the weeks a query returned nothing for.
 *
 * A week with no activity produces no row, and a chart that silently omits it
 * draws a straight line across the gap — which reads as steady rather than as
 * quiet. Every bucket in the window is emitted, zero or not.
 */
export function densify(
  rows: { week: string; n: number }[],
  weeks = CHART_WEEKS,
): { weekStart: string; count: number }[] {
  const byWeek = new Map(rows.map((r) => [new Date(r.week).toISOString().slice(0, 10), r.n]));
  const start = windowStart(weeks);

  return Array.from({ length: weeks }, (_, i) => {
    const d = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    return { weekStart: key, count: byWeek.get(key) ?? 0 };
  });
}

export interface CampaignAnalytics {
  totals: {
    sent: number;
    signups: number;
    /** Signups whose email is verified — the ones that actually scored. */
    successful: number;
    /** successful ÷ sent, as a percentage rounded to one decimal. */
    conversionRate: number;
    countries: number;
    continents: number;
  };
  weekly: {
    weekStart: string;
    sent: number;
    converted: number;
    /** Running total of converted, for the cumulative chart. */
    cumulative: number;
  }[];
  topReferrers: { rank: number; name: string; country: string | null; signups: number; points: number }[];
}

export const referralAnalyticsService = {
  /**
   * Everything the Analytics screen renders, in one call.
   *
   * Deliberately one endpoint rather than four: the screen never shows any of
   * these figures without the others, and four public endpoints would be four
   * separate table scans for one page view.
   */
  async campaign(): Promise<CampaignAnalytics> {
    const since = windowStart();

    const [
      [sentRow],
      [signupRow],
      [reachRow],
      weeklySent,
      weeklyConverted,
      topReferrers,
    ] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(referralInvites),

      db
        .select({
          signups: sql<number>`count(*)::int`,
          successful: sql<number>`count(*) filter (where ${referrals.creditedAt} is not null)::int`,
        })
        .from(referrals)
        .where(eq(referrals.status, 'active')),

      // Continents via a join rather than a distinct on country: two countries
      // can share one continent, so counting distinct country codes and calling
      // it continents would overstate the spread — the single most misleading
      // number this screen could show.
      db
        .select({
          countries: sql<number>`count(distinct ${referrals.redeemerCountry})::int`,
          continents: sql<number>`count(distinct ${countries.continent})::int`,
        })
        .from(referrals)
        .leftJoin(countries, eq(countries.code, referrals.redeemerCountry))
        .where(and(eq(referrals.status, 'active'), isNotNull(referrals.redeemerCountry))),

      db
        .select({
          week: sql<string>`date_trunc('week', ${referralInvites.sentAt})::date::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(referralInvites)
        .where(gte(referralInvites.sentAt, since))
        .groupBy(sql`1`),

      db
        .select({
          week: sql<string>`date_trunc('week', ${referrals.signedUpAt})::date::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(referrals)
        .where(and(eq(referrals.status, 'active'), gte(referrals.signedUpAt, since)))
        .groupBy(sql`1`),

      this.topReferrers(5),
    ]);

    const sentWeeks = densify(weeklySent);
    const convWeeks = densify(weeklyConverted);

    let running = 0;
    const weekly = sentWeeks.map((s, i) => {
      running += convWeeks[i].count;
      return {
        weekStart: s.weekStart,
        sent: s.count,
        converted: convWeeks[i].count,
        cumulative: running,
      };
    });

    const sent = sentRow.n;
    const successful = signupRow.successful;

    return {
      totals: {
        sent,
        signups: signupRow.signups,
        successful,
        // Guarded: a campaign with no sends yet would otherwise report NaN,
        // which serialises to null and breaks a percentage widget.
        conversionRate: sent === 0 ? 0 : Math.round((successful / sent) * 1000) / 10,
        countries: reachRow.countries,
        continents: reachRow.continents,
      },
      weekly,
      topReferrers,
    };
  },

  /**
   * The leaderboard the Analytics screen shows: ranked by how many people a
   * referrer actually brought in, not by points.
   *
   * A separate query from referralScoringService.leaderboard on purpose — that
   * one ranks by points, and the two orderings genuinely differ. Someone with
   * three cross-continent referrals outscores someone with fifteen domestic
   * ones, so "top referrer" means two different people depending on which
   * question is being asked. Points come along in the response so a client can
   * show both without a second call.
   *
   * Only credited referrals count. An unverified signup has not brought anyone
   * to Kinkané yet, and letting it rank someone would make the list gameable
   * with a throwaway address.
   */
  async topReferrers(limit = 5): Promise<CampaignAnalytics['topReferrers']> {
    const rows = await db
      .select({
        name: users.name,
        countryCode: users.countryCode,
        signups: sql<number>`count(*)::int`,
        points: sql<number>`coalesce((
          select sum(p.points)::int from referral_points p
          where p.user_id = ${referrals.referrerUserId} and p.state = 'counted'
        ), 0)`,
      })
      .from(referrals)
      .innerJoin(users, eq(users.id, referrals.referrerUserId))
      .where(and(eq(referrals.status, 'active'), isNotNull(referrals.creditedAt)))
      .groupBy(referrals.referrerUserId, users.name, users.countryCode)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.map((r, i) => ({
      rank: i + 1,
      // First name only, matching the public leaderboard. This response is
      // readable by anyone.
      name: r.name.split(' ')[0],
      country: r.countryCode,
      signups: r.signups,
      points: r.points,
    }));
  },

  /**
   * Anonymous city pins for the globe's "Others' referrals" layer.
   *
   * Cities with a count, and nothing else — no names, no ids, no way to tell
   * which pin is which person. That is what makes it safe to show a stranger's
   * activity to a logged-out visitor: the globe conveys that the campaign is
   * spreading without telling anyone who is doing the spreading.
   *
   * Cities with no coordinates are dropped rather than placed at (0, 0), which
   * would drop a pin in the Gulf of Guinea for every unresolvable user.
   */
  async cityPins(): Promise<{ city: string; countryCode: string | null; lat: number; lng: number; count: number }[]> {
    const rows = await db
      .select({
        city: users.city,
        countryCode: users.countryCode,
        lat: users.cityLat,
        lng: users.cityLng,
        count: sql<number>`count(*)::int`,
      })
      .from(users)
      .innerJoin(referrals, eq(referrals.referredUserId, users.id))
      .where(
        and(
          eq(referrals.status, 'active'),
          isNotNull(referrals.creditedAt),
          isNotNull(users.city),
          isNotNull(users.cityLat),
          isNotNull(users.cityLng),
        ),
      )
      .groupBy(users.city, users.countryCode, users.cityLat, users.cityLng);

    return rows.map((r) => ({
      city: r.city as string,
      countryCode: r.countryCode,
      lat: r.lat as number,
      lng: r.lng as number,
      count: r.count,
    }));
  },
};
