import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { referralAnalyticsService, type CampaignAnalytics } from '../referral-analytics.service';

/**
 * The referral competition, as the admin console sees it.
 *
 * The public Analytics screen and this one start from the same campaign
 * figures, so the totals and weekly series come from referralAnalyticsService
 * rather than a second copy of those queries — two implementations would drift,
 * and an operator comparing the console with the app would find two different
 * "countries reached". What differs is what each is allowed to show: the public
 * one names nobody beyond a first name, while this one lists every Traveller by
 * full name and email.
 */

export type TravellerSort = 'points' | 'signups' | 'recent';

export interface AdminTravellerQuery {
  q?: string;
  sort: TravellerSort;
  limit: number;
  offset: number;
}

/**
 * Who counts as a Traveller: anyone with a referral link, or anyone who arrived
 * through one.
 *
 * A link is created the first time someone opens their invite screen, so the
 * first half is "has taken part in the competition", whether or not anyone has
 * signed up under them yet — a Traveller with zero signups is exactly who an
 * operator looking for stalled referrers wants to see. The second half catches
 * people who joined through a link and have not opened their own invite screen.
 * Voided referrals do not make someone a Traveller.
 */
/**
 * The outer row's user id, spelled out in full.
 *
 * Interpolating `users.id` is not safe here. In a single-table select, Drizzle
 * prints a column in the select list as a bare `"id"`, and inside a subquery
 * over `referrals r` a bare `"id"` binds to `r.id` — so every figure would be
 * silently computed against the wrong row, with no error. Qualified, it can
 * only mean the outer user.
 */
const outerUserId = sql.raw('"users"."id"');

const isTraveller: SQL = sql`(
  exists (select 1 from referral_codes c where c.user_id = ${outerUserId})
  or exists (select 1 from referrals r where r.referred_user_id = ${outerUserId} and r.status = 'active')
)`;

// Per-row figures as correlated subqueries, like the customers screen: a page
// is at most 100 Travellers, and grouping every referral table to render them
// is the wrong shape. Each matches the definition the app's own invite screen
// uses (referralsService.statsFor) so a Traveller's row here and their own
// screen cannot disagree.
const invitesSent = sql<number>`(select count(*) from referral_invites i where i.user_id = ${outerUserId})::int`;

// Across every code the user has ever had, not just the active one: a revoked
// code's clicks were still clicks on this person's link.
const clicks = sql<number>`(
  select count(distinct (coalesce(k.ip_hash, k.id::text), coalesce(k.user_agent, '')))
  from referral_clicks k
  join referral_codes c on c.id = k.code_id
  where c.user_id = ${outerUserId} and not k.is_bot
)::int`;

const signups = sql<number>`(
  select count(*) from referrals r
  where r.referrer_user_id = ${outerUserId} and r.status = 'active'
)::int`;

const successful = sql<number>`(
  select count(*) from referrals r
  where r.referrer_user_id = ${outerUserId} and r.status = 'active' and r.credited_at is not null
)::int`;

// The whole network, any depth — the same figure the app labels "Countries
// Reached". ancestor_path always ends at the referrer, so direct referrals are
// covered by the containment test too.
const countriesReached = sql<number>`(
  select count(distinct r.redeemer_country) from referrals r
  where r.ancestor_path @> array[${outerUserId}]::integer[]
    and r.status = 'active' and r.redeemer_country is not null
)::int`;

const points = sql<number>`coalesce((
  select sum(p.points) from referral_points p
  where p.user_id = ${outerUserId} and p.state = 'counted'
), 0)::int`;

const referredById = sql<number | null>`(
  select r.referrer_user_id from referrals r
  where r.referred_user_id = ${outerUserId} and r.status = 'active'
)`;

const referredByName = sql<string | null>`(
  select u2.name from referrals r join users u2 on u2.id = r.referrer_user_id
  where r.referred_user_id = ${outerUserId} and r.status = 'active'
)`;

/**
 * Every ordering ends on the user id, so a tie never reorders between pages —
 * without it, two Travellers on equal points can swap places from one request
 * to the next and one of them appears on both pages while the other on neither.
 */
const ORDER: Record<TravellerSort, SQL[]> = {
  points: [desc(points), desc(signups), asc(users.id)],
  signups: [desc(successful), desc(signups), asc(users.id)],
  recent: [desc(users.createdAt), desc(users.id)],
};

export const adminReferralsService = {
  /**
   * Totals, the weekly sent/converted series and the running cumulative signups.
   *
   * Uncached, unlike the public endpoint: an operator checking a figure after a
   * correction should see it now, not in five minutes, and the console is a
   * handful of people rather than the open internet. `topReferrers` is dropped —
   * the Travellers list is the console's version of it, with full names and
   * every ordering.
   */
  async analytics(): Promise<
    { totals: CampaignAnalytics['totals'] & { travellers: number }; weekly: CampaignAnalytics['weekly'] }
  > {
    const [campaign, [travellers]] = await Promise.all([
      referralAnalyticsService.computeCampaign(),
      db.select({ n: sql<number>`count(*)::int` }).from(users).where(isTraveller),
    ]);

    return {
      totals: { ...campaign.totals, travellers: travellers.n },
      weekly: campaign.weekly,
    };
  },

  /** Every Traveller, paginated, with their own funnel and reach. */
  async travellers(query: AdminTravellerQuery) {
    const conditions: SQL[] = [isTraveller];
    if (query.q) {
      const like = `%${query.q}%`;
      conditions.push(or(ilike(users.name, like), ilike(users.email, like), ilike(users.username, like))!);
    }
    const where = and(...conditions);

    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          email: users.email,
          countryCode: users.countryCode,
          city: users.city,
          joinedAt: users.createdAt,
          referredById,
          referredByName,
          invitesSent,
          clicks,
          signups,
          successful,
          countriesReached,
          points,
        })
        .from(users)
        .where(where)
        .orderBy(...ORDER[query.sort])
        .limit(query.limit)
        .offset(query.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(users).where(where),
    ]);

    return {
      travellers: rows.map(({ referredById: id, referredByName: name, ...r }) => ({
        ...r,
        // Present only for people who arrived through someone's link. A
        // Traveller who started their own branch has no referrer.
        referredBy: id === null ? null : { id: Number(id), name },
        pending: r.signups - r.successful,
      })),
      total: total.n,
    };
  },
};
