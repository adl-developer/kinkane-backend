import crypto from 'crypto';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../db';
import {
  referralCodes,
  referralClicks,
  referralInvites,
  referrals,
  users,
  userSubscriptions,
} from '../db/schema';
import type { Referral } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { isBotUserAgent } from '../lib/user-agent';
import { randomCode } from '../lib/random-code';
import {
  activeCampaign,
  shortMessage,
  emailCopy,
  emailPlainText,
  type Campaign,
} from '../lib/referral-copy';
import { referralScoringService, MAX_DEPTH } from './referral-scoring.service';

/**
 * Referral links and attribution — who referred whom.
 *
 * Everything to do with what a referral is *worth* lives in
 * referral-scoring.service; this file owns only the facts.
 */

// ── Code generation ───────────────────────────────────────────────────────────

// Crockford base32 minus the characters people misread or mistype when copying a
// code off a screen: I, L, O and U are absent. A code is read aloud and retyped
// far more often than a password is.
const CODE_LENGTH = 10;

/**
 * A random code, never derived from the user id — a derivable code is an
 * enumerable one, and enumerating codes would expose the user list.
 *
 * The alphabet and the unbiased sampling live in lib/random-code, shared with
 * payment references: both are identifiers a human has to read off a screen and
 * retype, so both want the same ambiguous characters left out.
 */
export function generateCode(length = CODE_LENGTH): string {
  return randomCode(length);
}

// ── Slug ──────────────────────────────────────────────────────────────────────

const SLUG_MAX = 40;

/**
 * The decorative trailing segment of a referral link.
 *
 * Never used to resolve a code — resolution is by code alone. That is what lets
 * this be recomputed from the user's *current* name every time a link is
 * rendered while links already sent, carrying the old slug, keep working.
 *
 * NFKD-normalizing and stripping combining marks is what makes "Kinkané" into
 * "kinkane" rather than dropping the accented character. A name with no Latin
 * characters at all (Chinese, Arabic, emoji-only) legitimately reduces to
 * nothing, and gets `friend` — an empty trailing segment would produce a link
 * ending in a bare slash.
 */
export function slugifyName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // A truncation can land mid-word and leave a trailing hyphen.
    .replace(/-+$/g, '');

  return slug || 'friend';
}

/** The canonical link. Token first and authoritative, name slug last. */
export function buildReferralLink(code: string, name: string, channel?: string): string {
  const base = `${config.appUrl}/r/${code}/${slugifyName(name)}`;
  return channel ? `${base}?c=${encodeURIComponent(channel)}` : base;
}

// ── Share payloads ────────────────────────────────────────────────────────────

export interface SharePayloads {
  link: string;
  campaign: Campaign;
  message: string;
  whatsapp: string;
  sms: string;
  email: { subject: string; body: string; mailto: string };
  copy: string;
}

/**
 * Prebuilt share strings, so web and native word the invite identically and
 * every channel carries its own `?c=` tag without each client remembering to
 * add one.
 *
 * The words come from lib/referral-copy and switch on whether the launch
 * campaign is running. `campaign` is returned alongside so a client can key its
 * own UI (a progress meter, campaign artwork) off the same decision the copy
 * used, rather than re-deriving it from a date it would have to be told.
 */
export function buildSharePayloads(code: string, name: string): SharePayloads {
  const campaign = activeCampaign();
  const message = (channel: string): string =>
    shortMessage(buildReferralLink(code, name, channel), campaign);

  const copy = emailCopy(campaign);
  const emailBody = emailPlainText(copy, buildReferralLink(code, name, 'email'));

  return {
    link: buildReferralLink(code, name),
    campaign,
    message: message('copy'),
    whatsapp: `https://wa.me/?text=${encodeURIComponent(message('whatsapp'))}`,
    sms: `sms:?&body=${encodeURIComponent(message('sms'))}`,
    email: {
      subject: copy.subject,
      body: emailBody,
      mailto: `mailto:?subject=${encodeURIComponent(copy.subject)}&body=${encodeURIComponent(emailBody)}`,
    },
    copy: message('copy'),
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function hashIp(ip: string): string {
  // Hashed, not stored raw: this table gets one row per click on an
  // unauthenticated endpoint, and it has no need for a reversible IP.
  return crypto.createHash('sha256').update(ip).digest('hex');
}

/**
 * Hash of an invited email address.
 *
 * Lower-cased and trimmed first so "Ama@Example.com " and "ama@example.com"
 * dedupe to the same invite — otherwise the same person re-invited with
 * different capitalisation counts twice on the Sent figure.
 *
 * The address itself is never stored. The invitee is not a user and has agreed
 * to nothing; a hash is enough to dedupe and to match a later signup back.
 */
function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** Channels a share can be reported on. Anything else is rejected at the route. */
export const SHARE_CHANNELS = ['whatsapp', 'sms', 'copy', 'link'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/**
 * "Amara Sowande" → "Amara S." — how a referred reader is named on someone
 * else's journey map.
 *
 * The people on this map did not sign up to be shown to whoever shared a link
 * with them; they signed up to buy books. A first name and an initial is enough
 * for a referrer to recognise the friend they actually invited, and not enough
 * to identify a stranger three hops down. It is the same instinct the public
 * leaderboard already follows in showing first names only.
 *
 * A single-word name gets no initial rather than a stray full stop, and a name
 * that is empty or whitespace falls back to "A reader" — the map must not
 * render a blank label.
 */
export function redactName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'A reader';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export interface NetworkNode {
  id: number;
  name: string;
  city: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  /** Who referred them — the caller's own id for a first-degree node. */
  referrerId: number;
  /** Hops from the caller. 1 = someone they personally invited. */
  degree: number;
  /** How many people this node has themselves referred, within this network. */
  directReferrals: number;
  signedUpAt: Date;
  /** False while they have signed up but not yet verified their email. */
  credited: boolean;
}

export interface NetworkSummary {
  directReferrals: number;
  networkTotal: number;
  degreesOfInfluence: number;
  citiesReached: number;
  countriesReached: number;
  byDegree: { degree: number; count: number }[];
  longestChain: { links: number; hops: { name: string; city: string | null; countryCode: string | null }[] };
}

/**
 * How deep this user sits in whatever tree they belong to.
 *
 * Depths stored on `referrals` are absolute — distance from the root of the
 * tree, not from whoever is asking — so any view drawn from one user outward
 * has to offset by where that user sits.
 *
 * It must be read from the user's *own* referral row and never inferred from
 * their descendants. Inferring it (say, from the shallowest surviving
 * descendant) breaks the moment a direct referral is voided: the grandchildren
 * survive, the shallowest remaining row is a generation deeper than it was, and
 * every degree in the response silently shifts one closer.
 *
 * 0 for a root, who has no row here at all.
 */
async function depthOf(userId: number): Promise<number> {
  const [row] = await db
    .select({ depth: referrals.depth })
    .from(referrals)
    .where(eq(referrals.referredUserId, userId))
    .limit(1);

  return row?.depth ?? 0;
}

export const referralsService = {
  generateCode,
  slugifyName,
  buildReferralLink,
  buildSharePayloads,

  /**
   * The caller's referral code, minted on first use.
   *
   * Idempotent under concurrency: two simultaneous requests both insert, one
   * loses on the unique index, and the loser re-reads the winner's row rather
   * than surfacing a 500 for what is a perfectly ordinary race.
   */
  async getOrCreateCode(userId: number): Promise<{ code: string; slug: string }> {
    const [existing] = await db
      .select({ code: referralCodes.code, slug: referralCodes.slug })
      .from(referralCodes)
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, true)))
      .limit(1);
    if (existing) return existing;

    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const slug = slugifyName(user.name);

    // A code collision is astronomically unlikely (32^10) but the retry is three
    // lines, and the alternative is a signup-time 500 nobody can reproduce.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const [inserted] = await db
        .insert(referralCodes)
        .values({ userId, code, slug })
        .onConflictDoNothing()
        .returning({ code: referralCodes.code, slug: referralCodes.slug });

      if (inserted) return inserted;

      // Conflict — either this user raced us, or (vanishingly) the code did.
      const [row] = await db
        .select({ code: referralCodes.code, slug: referralCodes.slug })
        .from(referralCodes)
        .where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, true)))
        .limit(1);
      if (row) return row;
    }

    throw new Error('Could not allocate a referral code');
  },

  /** Rotates a user's code, revoking the old one. Past attributions are untouched. */
  async rotateCode(userId: number): Promise<{ code: string; slug: string }> {
    await db
      .update(referralCodes)
      .set({ isActive: false, revokedAt: new Date() })
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, true)));

    // The unique index is on user_id alone, so the revoked row has to go before
    // a replacement can exist. Attribution already made through the old code
    // survives in `referrals` — code_id is ON DELETE SET NULL, and the referral
    // row is the record that matters.
    await db.delete(referralCodes).where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, false)));

    return this.getOrCreateCode(userId);
  },

  /** Resolves a code to its owner, or null. Revoked and unknown look identical. */
  async resolveCode(code: string): Promise<{ id: number; userId: number } | null> {
    const [row] = await db
      .select({ id: referralCodes.id, userId: referralCodes.userId })
      .from(referralCodes)
      .where(and(eq(referralCodes.code, code.toUpperCase()), eq(referralCodes.isActive, true)))
      .limit(1);
    return row ?? null;
  },

  /**
   * Records that an invite email was queued to an address.
   *
   * Re-inviting an address already invited is a no-op rather than a second row:
   * "Sent" counts people invited, not messages dispatched, and a user who
   * re-sends to a friend who hasn't signed up yet has not reached anyone new.
   */
  async recordInvite(userId: number, email: string): Promise<void> {
    await db
      .insert(referralInvites)
      .values({ userId, channel: 'email', recipientHash: hashEmail(email) })
      .onConflictDoNothing();
  },

  /**
   * Records a share the user initiated on a channel with no recipient we can
   * see — a WhatsApp tap, a copied link.
   *
   * Always a new row, unlike an email invite: there is no recipient to dedupe
   * on, and sharing the same link into three different group chats genuinely is
   * three shares. This is the softer half of "Sent" — evidence of intent, not
   * of delivery — and the naming throughout keeps that distinction visible.
   */
  async recordShare(userId: number, channel: ShareChannel): Promise<void> {
    await db.insert(referralInvites).values({ userId, channel });
  },

  /** Logs a click. Best-effort: a failure here must not break the redirect. */
  async logClick(params: {
    codeId: number;
    channel?: string;
    ip?: string;
    userAgent?: string;
    countryCode?: string | null;
  }): Promise<number | null> {
    try {
      const [row] = await db
        .insert(referralClicks)
        .values({
          codeId: params.codeId,
          channel: params.channel?.slice(0, 20),
          ipHash: params.ip ? hashIp(params.ip) : null,
          userAgent: params.userAgent?.slice(0, 500),
          countryCode: params.countryCode ?? null,
          isBot: isBotUserAgent(params.userAgent),
        })
        .returning({ id: referralClicks.id });
      return row.id;
    } catch (err) {
      logger.warn('Failed to log referral click', { error: (err as Error).message });
      return null;
    }
  },

  /**
   * Writes the attribution edge for a newly created user, inside the caller's
   * signup transaction, together with its direct points award.
   *
   * Returns null — without throwing — for every ordinary reason a referral
   * simply doesn't apply: no code, an unknown code, a self-referral, or a chain
   * already at MAX_DEPTH. None of those are errors the person signing up can do
   * anything about, and none should cost them their account.
   */
  async attributeSignup(
    tx: Tx,
    params: {
      referredUserId: number;
      code: string;
      redeemerCountry: string | null;
      redeemerCity?: string | null;
      channel?: string;
      clickId?: number | null;
    },
  ): Promise<Referral | null> {
    const [codeRow] = await tx
      .select({ id: referralCodes.id, userId: referralCodes.userId })
      .from(referralCodes)
      .where(and(eq(referralCodes.code, params.code.toUpperCase()), eq(referralCodes.isActive, true)))
      .limit(1);

    if (!codeRow) {
      logger.info('Signup carried an unknown referral code', { code: params.code });
      return null;
    }

    const referrerUserId = codeRow.userId;

    // Belt and braces against the CHECK constraint — reaching the database with
    // a self-referral would abort the whole signup transaction.
    if (referrerUserId === params.referredUserId) return null;

    // The referrer's own row, if they were themselves referred. Its absence
    // means they are a root.
    const [parent] = await tx
      .select({ depth: referrals.depth, ancestorPath: referrals.ancestorPath, rootReferrerId: referrals.rootReferrerId })
      .from(referrals)
      .where(eq(referrals.referredUserId, referrerUserId))
      .limit(1);

    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      logger.warn('Referral chain exceeded max depth — not attributed', {
        referrerUserId,
        referredUserId: params.referredUserId,
        depth,
      });
      return null;
    }

    // Root first, ending at the direct referrer.
    const ancestorPath = [...(parent?.ancestorPath ?? []), referrerUserId];
    const rootReferrerId = parent?.rootReferrerId ?? referrerUserId;

    const [referrerRow] = await tx
      .select({ countryCode: users.countryCode, city: users.city, tier: userSubscriptions.tier })
      .from(users)
      .leftJoin(userSubscriptions, eq(userSubscriptions.userId, users.id))
      .where(eq(users.id, referrerUserId))
      .limit(1);

    // One person removed — the referrer's own referrer, who earns the
    // second-degree award. It is the last entry of the *parent's* path, i.e. the
    // second-to-last of this new node's path. Undefined when the referrer is a
    // root, which is the common case early on.
    //
    // Nothing above this is fetched, deliberately: "beyond 1 person removed, you
    // can't earn any other points through that branch".
    const grandReferrerUserId = ancestorPath.length >= 2 ? ancestorPath[ancestorPath.length - 2] : null;

    const [grandReferrerRow] = grandReferrerUserId
      ? await tx
          .select({ countryCode: users.countryCode })
          .from(users)
          .where(eq(users.id, grandReferrerUserId))
          .limit(1)
      : [undefined];

    const [referral] = await tx
      .insert(referrals)
      .values({
        referrerUserId,
        referredUserId: params.referredUserId,
        codeId: codeRow.id,
        clickId: params.clickId ?? null,
        channel: params.channel?.slice(0, 20),
        depth,
        rootReferrerId,
        ancestorPath,
        referrerCountry: referrerRow?.countryCode ?? null,
        redeemerCountry: params.redeemerCountry,
        grandReferrerCountry: grandReferrerRow?.countryCode ?? null,
        referrerCity: referrerRow?.city ?? null,
        redeemerCity: params.redeemerCity ?? null,
        referrerTierAtReferral: referrerRow?.tier ?? null,
        // Deliberately not credited here. Points are written when the referred
        // reader verifies their email — see creditVerifiedSignup. The one
        // exception is a signup that arrives already verified (Google OAuth),
        // which the caller credits immediately after this returns.
      })
      .returning();

    return referral;
  },

  /**
   * Writes the points for a referral whose referred reader has just verified.
   *
   * Split out of attributeSignup because credit now happens at verification
   * rather than at signup: an unverified account is a disposable inbox until
   * proven otherwise, and the competition should not pay for one.
   *
   * Idempotent on three independent levels, which matters because verification
   * can be retried and OAuth signups call this milliseconds after attribution:
   * the `credited_at is null` guard means only one caller wins the update, the
   * (referral_id, kind) unique index makes a double award a no-op, and the
   * circuit index does the same for circuits.
   *
   * Returns false when there was nothing to credit — no referral, already
   * credited, or voided. Never throws for those: a verification must not fail
   * because of anything in the competition.
   */
  async creditVerifiedSignup(referredUserId: number): Promise<boolean> {
    const [referral] = await db
      .select({
        id: referrals.id,
        referrerUserId: referrals.referrerUserId,
        ancestorPath: referrals.ancestorPath,
        referrerCountry: referrals.referrerCountry,
        redeemerCountry: referrals.redeemerCountry,
        grandReferrerCountry: referrals.grandReferrerCountry,
      })
      .from(referrals)
      .where(
        and(
          eq(referrals.referredUserId, referredUserId),
          eq(referrals.status, 'active'),
          sql`${referrals.creditedAt} is null`,
        ),
      )
      .limit(1);

    if (!referral) return false;

    const grandReferrerUserId =
      referral.ancestorPath.length >= 2 ? referral.ancestorPath[referral.ancestorPath.length - 2] : null;

    const credited = await db.transaction(async (tx) => {
      // Claim the referral first. Two concurrent verifications (a retry racing
      // the original) both reach here; only the one that flips a null
      // credited_at goes on to write points.
      // `status` is re-checked here as well as in the read above: an admin can
      // void a referral in the window between the two, and without this the
      // claim would happily credit a referral that was voided a moment ago.
      const claimed = await tx
        .update(referrals)
        .set({ creditedAt: new Date() })
        .where(
          and(
            eq(referrals.id, referral.id),
            eq(referrals.status, 'active'),
            sql`${referrals.creditedAt} is null`,
          ),
        )
        .returning({ id: referrals.id });

      if (claimed.length === 0) return false;

      await referralScoringService.awardDirect(tx, {
        referralId: referral.id,
        referrerUserId: referral.referrerUserId,
        referrerCountry: referral.referrerCountry,
        redeemerCountry: referral.redeemerCountry,
        grandReferrerUserId,
        // The snapshot, not a live lookup. All three geographies scoring this
        // redemption now describe the same moment — the one the reader signed
        // up in — however long the wait for verification turns out to be.
        grandReferrerCountry: referral.grandReferrerCountry,
      });

      return true;
    });

    return credited;
  },

  /**
   * The funnel for one user's code.
   *
   * `countriesReached` spans the whole network — every descendant, any depth —
   * while `signups`, `successful` and `pending` count only direct referrals.
   * That asymmetry is deliberate: the funnel is about people this user
   * personally brought in, whereas reach is the whole point of a competition
   * called Around the World and is meaningless if it stops at one generation.
   *
   * Three of these figures are the Sent / Successful / Pending card, and they
   * deliberately do *not* satisfy Sent = Successful + Pending. Sent counts
   * invites and shares this user initiated; successful and pending count people
   * who arrived, which includes everyone who found the link second-hand — a
   * forwarded WhatsApp message, a link pasted into a group. Forcing the three
   * to reconcile would mean either discarding those signups or inventing sends
   * that never happened.
   */
  async statsFor(userId: number): Promise<{
    clicks: number;
    signups: number;
    sent: number;
    successful: number;
    pending: number;
    countriesReached: string[];
  }> {
    const [codeRow] = await db
      .select({ id: referralCodes.id })
      .from(referralCodes)
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, true)))
      .limit(1);

    // Unique people, not raw hits.
    //
    // Deduped on (hashed IP, user agent) rather than IP alone: a household,
    // office or mobile carrier behind one NAT would otherwise collapse to a
    // single click no matter how many people actually followed the link, and
    // shared egress IPs are the norm in a lot of the world. The pair is not a
    // perfect identity — the same person on wifi then mobile data counts twice,
    // and there is no cookie to do better on a redirect that must stay
    // anonymous — but it is much closer than either extreme.
    //
    // The COALESCE on ip_hash keeps clicks with no recorded IP distinct: without
    // it, every such row shares a NULL and the whole set collapses to one.
    // Bots are excluded here rather than at insert, so preview traffic stays
    // inspectable in the table.
    const [clickRow] = codeRow
      ? await db
          .select({
            n: sql<number>`count(distinct (coalesce(${referralClicks.ipHash}, ${referralClicks.id}::text), coalesce(${referralClicks.userAgent}, '')))::int`,
          })
          .from(referralClicks)
          .where(and(eq(referralClicks.codeId, codeRow.id), eq(referralClicks.isBot, false)))
      : [{ n: 0 }];

    const direct = await db
      .select({ redeemerCountry: referrals.redeemerCountry, creditedAt: referrals.creditedAt })
      .from(referrals)
      .where(and(eq(referrals.referrerUserId, userId), eq(referrals.status, 'active')));

    const [sentRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(referralInvites)
      .where(eq(referralInvites.userId, userId));

    // Countries across the WHOLE network, not just direct referrals — the same
    // question /me/network answers, so the two endpoints cannot disagree about
    // a figure both screens label "Countries Reached".
    //
    // A separate containment scan rather than reading it off `direct`: a
    // referrer whose friend-of-a-friend is the only person in Peru has still
    // reached Peru, and their own direct rows say nothing about it.
    const reached = await db
      .selectDistinct({ country: referrals.redeemerCountry })
      .from(referrals)
      .where(
        and(
          sql`${referrals.ancestorPath} @> ARRAY[${userId}]::integer[]`,
          eq(referrals.status, 'active'),
        ),
      );

    const successful = direct.filter((d) => d.creditedAt !== null).length;

    return {
      clicks: clickRow.n,
      // Kept as the total headcount of people who signed up under this user,
      // credited or not. `successful` is the narrower, points-bearing figure.
      signups: direct.length,
      sent: sentRow.n,
      successful,
      pending: direct.length - successful,
      // Counted from everyone who arrived, not only the credited — an unverified
      // signup in a new country has still reached that country.
      countriesReached: reached
        .map((r) => r.country)
        .filter((c): c is string => !!c)
        .sort(),
    };
  },

  /**
   * Who this user has referred, directly and indirectly, any depth.
   *
   * One GIN-indexed containment scan rather than a recursive CTE — the whole
   * reason ancestor_path is stored. `maxDepth` trims the response for rendering;
   * it has never limited what is tracked.
   */
  async treeFor(userId: number, maxDepth = MAX_DEPTH): Promise<
    {
      referredUserId: number;
      name: string;
      countryCode: string | null;
      city: string | null;
      cityLat: number | null;
      cityLng: number | null;
      referrerUserId: number;
      depth: number;
      signedUpAt: Date;
      creditedAt: Date | null;
    }[]
  > {
    const base = await depthOf(userId);

    return db
      .select({
        referredUserId: referrals.referredUserId,
        name: users.name,
        countryCode: users.countryCode,
        // City from the *user*, not the referral snapshot, deliberately. The
        // snapshot on the referral row records where a hop happened; this map
        // is a picture of where people are, and the user row is the one that
        // an admin correction fixes. The snapshots exist so scoring history
        // stays stable, and nothing here is scoring.
        city: users.city,
        cityLat: users.cityLat,
        cityLng: users.cityLng,
        referrerUserId: referrals.referrerUserId,
        depth: referrals.depth,
        signedUpAt: referrals.signedUpAt,
        creditedAt: referrals.creditedAt,
      })
      .from(referrals)
      .innerJoin(users, eq(users.id, referrals.referredUserId))
      .where(
        and(
          sql`${referrals.ancestorPath} @> ARRAY[${userId}]::integer[]`,
          eq(referrals.status, 'active'),
          sql`${referrals.depth} <= ${base + maxDepth}`,
        ),
      )
      .orderBy(referrals.depth, desc(referrals.signedUpAt));
  },

  /**
   * The caller's network, shaped for the journey map and the globe.
   *
   * One tree read, then everything the two screens need computed in memory
   * rather than as five more round trips: the whole set is already loaded, and
   * counting over it is cheaper than asking Postgres the same question again
   * from four angles.
   *
   * Every name is redacted here rather than at the route, so there is exactly
   * one place a full name could ever leak from — and it is not on this path.
   */
  async networkFor(userId: number): Promise<{ summary: NetworkSummary; nodes: NetworkNode[] }> {
    // Both reads, not one: the caller's own depth is what every degree below is
    // measured against, and it cannot be recovered from the rows themselves —
    // see depthOf.
    const [rows, base] = await Promise.all([this.treeFor(userId), depthOf(userId)]);

    const childCounts = new Map<number, number>();
    for (const r of rows) childCounts.set(r.referrerUserId, (childCounts.get(r.referrerUserId) ?? 0) + 1);

    const nodes: NetworkNode[] = rows.map((r) => ({
      id: r.referredUserId,
      name: redactName(r.name),
      city: r.city,
      countryCode: r.countryCode,
      lat: r.cityLat,
      lng: r.cityLng,
      referrerId: r.referrerUserId,
      degree: r.depth - base,
      directReferrals: childCounts.get(r.referredUserId) ?? 0,
      signedUpAt: r.signedUpAt,
      credited: r.creditedAt !== null,
    }));

    const byDegreeMap = new Map<number, number>();
    for (const n of nodes) byDegreeMap.set(n.degree, (byDegreeMap.get(n.degree) ?? 0) + 1);

    // Contiguous from 1, so a client can render "1st / 2nd / 3rd / 4th" without
    // discovering a hole. A gap is impossible anyway — a node at degree 3
    // implies a parent at 2 — but relying on that in the client is a trap.
    const maxDegree = nodes.reduce((m, n) => Math.max(m, n.degree), 0);
    const byDegree = Array.from({ length: maxDegree }, (_, i) => ({
      degree: i + 1,
      count: byDegreeMap.get(i + 1) ?? 0,
    }));

    return {
      summary: {
        directReferrals: byDegreeMap.get(1) ?? 0,
        networkTotal: nodes.length,
        degreesOfInfluence: maxDegree,
        citiesReached: new Set(nodes.map((n) => n.city).filter(Boolean)).size,
        countriesReached: new Set(nodes.map((n) => n.countryCode).filter(Boolean)).size,
        byDegree,
        longestChain: buildLongestChain(userId, nodes),
      },
      nodes,
    };
  },
};

/**
 * The deepest single path through the network, as the "Accra → Paris →
 * Calcutta → Hong Kong → Singapore" strip on the journey map.
 *
 * Walks up from the deepest node rather than searching down from the caller:
 * the deepest node *is* the end of a longest path, and every node stores its
 * parent, so one walk up the chain reproduces the path in reverse. Searching
 * downward would mean exploring every branch to find out which was longest.
 *
 * Ties are broken by taking the earliest-joined of the deepest nodes, so the
 * chain a user sees is stable between refreshes rather than flipping between
 * two equally deep branches.
 *
 * `links` counts hops, not people — five names are four links, which is what
 * "4 links deep" on the design means.
 */
export function buildLongestChain(rootUserId: number, nodes: NetworkNode[]): NetworkSummary['longestChain'] {
  if (nodes.length === 0) return { links: 0, hops: [] };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxDegree = nodes.reduce((m, n) => Math.max(m, n.degree), 0);

  const deepest = nodes
    .filter((n) => n.degree === maxDegree)
    .sort((a, b) => a.signedUpAt.getTime() - b.signedUpAt.getTime())[0];

  const hops: NetworkSummary['longestChain']['hops'] = [];
  let cursor: NetworkNode | undefined = deepest;
  while (cursor) {
    hops.unshift({ name: cursor.name, city: cursor.city, countryCode: cursor.countryCode });
    // Stops at the caller, who is not in `nodes` — they are the root of this
    // view, and the client renders them as "You".
    cursor = cursor.referrerId === rootUserId ? undefined : byId.get(cursor.referrerId);
  }

  return { links: hops.length, hops };
}
