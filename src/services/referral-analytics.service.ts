import { sql, eq, and, gte, isNotNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { referrals, referralInvites, referralClicks, users, countries } from '../db/schema';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { config } from '../config';

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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a campaign-wide response is served from Redis.
 *
 * Both endpoints here are public, unauthenticated, and return the *same* bytes
 * to every caller — while doing full aggregate scans of `referrals`,
 * `referral_invites` and `users` to produce them. Uncached, that is a table
 * scan per page view and an open invitation to anyone with a loop.
 *
 * Five minutes because these are campaign totals: nobody watching a counter
 * climb can tell the difference, and a figure that lags by a few minutes is a
 * far smaller problem than one that falls over under load.
 */
const CACHE_TTL_SECONDS = 5 * 60;

/**
 * How many readers a city needs before it earns a pin on the public globe.
 *
 * /referrals/map needs no authentication, and a pin reading `count: 1` says
 * "exactly one Kinkané reader is in this city". Put that beside
 * /referrals/leaderboard — also public, also carrying a first name and a
 * country — and a named person can be placed in a named city by anyone who
 * cares to cross-reference the two.
 *
 * Three is the conventional floor for this kind of aggregate. The cost is real
 * and worth stating: while the campaign is small the globe under-represents how
 * far it has actually spread, because thinly-populated cities are withheld
 * rather than drawn. That is the right way round — a sparse globe is a
 * presentation problem, a locatable reader is not.
 */
const MIN_PIN_GROUP = 3;

/**
 * Reads through Redis, falling back to the query on a miss *or a Redis
 * failure*.
 *
 * A cache being unavailable must never turn a working page into an error, so
 * every Redis call here is wrapped and a failure is logged and ignored. The
 * result is cached even when it is empty — an early campaign with no data would
 * otherwise re-run the whole aggregate on every request and find nothing,
 * forever.
 */
async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn('Referral analytics cache read failed', { key, error: (err as Error).message });
  }

  const value = await compute();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn('Referral analytics cache write failed', { key, error: (err as Error).message });
  }

  return value;
}

/**
 * Monday 00:00 UTC on or before `d`.
 *
 * Monday-based, to match Postgres's date_trunc('week'). The queries pin that
 * truncation to UTC with an explicit AT TIME ZONE rather than relying on the
 * session. date_trunc on a timestamptz truncates in the *session* time zone,
 * which nothing in the connection setup pins, so on a deployment whose Postgres
 * defaults to a regional zone the buckets would land on local Mondays while
 * these keys stayed on UTC ones. Every lookup in densify would miss and both
 * charts would render zero bars beside healthy non-zero totals — no error, just
 * a flat line.
 */
export function weekOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/**
 * Day one of the competition, from which every week is numbered.
 *
 * Configured, or else the earliest invite anyone ever sent — for an
 * unconfigured deploy the campaign effectively began when someone first shared
 * a link. With neither (nothing sent yet) the window is this week alone, which
 * is the truthful answer rather than a fabricated history.
 */
export async function campaignStart(): Promise<Date> {
  if (config.referrals.campaignStartsAt) return config.referrals.campaignStartsAt;

  const [row] = await db
    .select({ first: sql<string | null>`min(${referralInvites.sentAt})` })
    .from(referralInvites);

  return row?.first ? new Date(row.first) : new Date();
}

export interface WeekBucket {
  /** 1-based week of the campaign — what a chart labels "Wk 3". */
  weekNumber: number;
  /** Monday, UTC. */
  weekStart: string;
  /** The Sunday that closes the bucket, inclusive. */
  weekEnd: string;
}

/**
 * Every week from the campaign's first through the one in progress.
 *
 * The window grows with the campaign rather than rolling: week 1 stays week 1
 * forever, so a bar's position means the same thing in October as it did in
 * August. A start mid-week snaps back to its Monday, which makes week 1 a
 * partial week — it will read low, and that is the honest shape of a campaign
 * that launched on a Wednesday.
 */
export function weekBuckets(start: Date, now = new Date()): WeekBucket[] {
  const first = weekOf(start);
  const span = Math.floor((weekOf(now).getTime() - first.getTime()) / WEEK_MS) + 1;

  // A start date in the future would otherwise produce an empty window and a
  // chart with no axis at all.
  return Array.from({ length: Math.max(span, 1) }, (_, i) => {
    const monday = new Date(first.getTime() + i * WEEK_MS);
    return {
      weekNumber: i + 1,
      weekStart: monday.toISOString().slice(0, 10),
      weekEnd: new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    };
  });
}

/**
 * Fills the weeks a query returned nothing for.
 *
 * A week with no activity produces no row, and a chart that silently omits it
 * draws a straight line across the gap — which reads as steady rather than as
 * quiet. Every bucket in the window gets a count, zero or not.
 */
export function densify(rows: { week: string; n: number }[], buckets: WeekBucket[]): number[] {
  const byWeek = new Map(rows.map((r) => [new Date(r.week).toISOString().slice(0, 10), r.n]));
  return buckets.map((b) => byWeek.get(b.weekStart) ?? 0);
}

export interface CampaignAnalytics {
  totals: {
    sent: number;
    /** Unique link taps across the campaign, bots excluded. */
    clicks: number;
    signups: number;
    /** Signups whose email is verified — the ones that actually scored. */
    successful: number;
    /**
     * successful ÷ clicks, as a percentage rounded to one decimal.
     *
     * Against clicks, not `sent`. `sent` counts what referrers initiated and can
     * be far smaller than the signups it produced — a link forwarded around a
     * group chat is one share and many arrivals — so dividing by it is not a
     * rate at all and routinely exceeds 100%.
     *
     * Clicks is much the better denominator but **not a strict superset of the
     * numerator**, so this can still print above 100 in two situations, both
     * worth knowing before anyone treats it as a true funnel:
     *
     * 1. A code typed into the "Have an invite code?" field on signup credits a
     *    referral with no click behind it. That field is the only recovery path
     *    for people who tapped a link, went to the App Store, and installed —
     *    so it is used, not hypothetical.
     * 2. Taps that open an installed app directly never reach this server
     *    unless the client reports them (see POST /referrals/clicks). Where a
     *    client does not, clicks under-counts and this figure reads high.
     *
     * Both push in the same direction, so treat this as an upper bound rather
     * than a measurement until click reporting is live on every client.
     */
    conversionRate: number;
    countries: number;
    continents: number;
  };
  weekly: (WeekBucket & {
    sent: number;
    converted: number;
    /** Running total of converted, for the cumulative chart. */
    cumulative: number;
  })[];
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
    return cached('referrals:analytics:v2', () => this.computeCampaign());
  },

  /** The uncached aggregate. Split out so the cache wrapper stays readable. */
  async computeCampaign(): Promise<CampaignAnalytics> {
    const buckets = weekBuckets(await campaignStart());
    const since = new Date(`${buckets[0].weekStart}T00:00:00Z`);

    const [
      [sentRow],
      [clickRow],
      [signupRow],
      [reachRow],
      weeklySent,
      weeklyConverted,
      topReferrers,
    ] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(referralInvites),

      // Deduped per (code, person), so the campaign total equals the sum of
      // everyone's own `clicks` rather than something smaller.
      //
      // `code_id` is load-bearing and easy to drop. statsFor uses the same
      // (ip_hash, user_agent) pair, but scoped by a WHERE to one code, where it
      // means "distinct people who followed this link". Lifted to a campaign-wide
      // scan without code_id in the tuple it silently becomes "distinct devices
      // that clicked anything" — so two hundred colleagues behind one office NAT,
      // each following a different workmate's link on the same browser build,
      // would collapse to a single click. Shared egress is the norm across much
      // of the world, so that is a systematic undercount, and since this is the
      // denominator of conversionRate it would inflate the published rate by
      // exactly that factor.
      //
      // Bots are excluded: link-preview fetchers from WhatsApp and Slack hit the
      // redirect exactly as a person does, and counting them would pad the
      // denominator and depress the rate instead.
      db
        .select({
          n: sql<number>`count(distinct (${referralClicks.codeId}, coalesce(${referralClicks.ipHash}, ${referralClicks.id}::text), coalesce(${referralClicks.userAgent}, '')))::int`,
        })
        .from(referralClicks)
        .where(eq(referralClicks.isBot, false)),

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
          week: sql<string>`date_trunc('week', ${referralInvites.sentAt} at time zone 'UTC')::date::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(referralInvites)
        .where(gte(referralInvites.sentAt, since))
        .groupBy(sql`1`),

      db
        .select({
          week: sql<string>`date_trunc('week', ${referrals.signedUpAt} at time zone 'UTC')::date::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(referrals)
        .where(and(eq(referrals.status, 'active'), gte(referrals.signedUpAt, since)))
        .groupBy(sql`1`),

      this.topReferrers(5),
    ]);

    const sentWeeks = densify(weeklySent, buckets);
    const convWeeks = densify(weeklyConverted, buckets);

    let running = 0;
    const weekly = buckets.map((b, i) => {
      running += convWeeks[i];
      return { ...b, sent: sentWeeks[i], converted: convWeeks[i], cumulative: running };
    });

    const sent = sentRow.n;
    const clicks = clickRow.n;
    const successful = signupRow.successful;

    return {
      totals: {
        sent,
        clicks,
        signups: signupRow.signups,
        successful,
        // Guarded: a campaign with no clicks yet would otherwise report NaN,
        // which serialises to null and breaks a percentage widget.
        conversionRate: clicks === 0 ? 0 : Math.round((successful / clicks) * 1000) / 10,
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
   * Counts every placeable reader, not only those who arrived through someone
   * else's link. An earlier version inner-joined to `referrals` on
   * `referred_user_id`, which silently excluded every tree root — so the people
   * doing the referring were invisible on the map of referrals, and early in a
   * campaign, when almost everyone is a root, the globe rendered nearly empty
   * at exactly the moment it most needs to look alive.
   *
   * Cities with no coordinates are dropped rather than placed at (0, 0), which
   * would drop a pin in the Gulf of Guinea for every unresolvable user. Cities
   * with fewer than MIN_PIN_GROUP readers are withheld too — see that constant
   * for why, and for what it costs.
   */
  async cityPins(): Promise<{ city: string; countryCode: string | null; lat: number; lng: number; count: number }[]> {
    return cached('referrals:map:v1', () => this.computeCityPins());
  },

  /** The uncached aggregate. */
  async computeCityPins(): Promise<{ city: string; countryCode: string | null; lat: number; lng: number; count: number }[]> {
    const rows = await db
      .select({
        city: users.city,
        countryCode: users.countryCode,
        lat: users.cityLat,
        lng: users.cityLng,
        count: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(and(isNotNull(users.city), isNotNull(users.cityLat), isNotNull(users.cityLng)))
      .groupBy(users.city, users.countryCode, users.cityLat, users.cityLng)
      // Withheld in SQL rather than filtered in JS, so a city below the
      // threshold never leaves the database and cannot be leaked by some later
      // caller that forgets to filter.
      .having(sql`count(*) >= ${MIN_PIN_GROUP}`);

    return rows.map((r) => ({
      city: r.city as string,
      countryCode: r.countryCode,
      lat: r.lat as number,
      lng: r.lng as number,
      count: r.count,
    }));
  },
};
