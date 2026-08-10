import crypto from 'crypto';
import { eq, and, sql, desc, count } from 'drizzle-orm';
import { db } from '../db';
import {
  referralCodes,
  referralClicks,
  referrals,
  users,
  userSubscriptions,
} from '../db/schema';
import type { Referral } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
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
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

/**
 * A random code, never derived from the user id — a derivable code is an
 * enumerable one, and enumerating codes would expose the user list.
 *
 * Rejection sampling rather than `% alphabet.length`: 256 is not a multiple of
 * 32 in general (it is here, but the alphabet is a constant someone will edit),
 * and a modulo bias in the one function that has to be unpredictable is not
 * worth leaving as a trap.
 */
export function generateCode(length = CODE_LENGTH): string {
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= max) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
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
      .select({ countryCode: users.countryCode, tier: userSubscriptions.tier })
      .from(users)
      .leftJoin(userSubscriptions, eq(userSubscriptions.userId, users.id))
      .where(eq(users.id, referrerUserId))
      .limit(1);

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
        referrerTierAtReferral: referrerRow?.tier ?? null,
      })
      .returning();

    await referralScoringService.awardDirect(tx, {
      referralId: referral.id,
      referrerUserId,
      referrerCountry: referrerRow?.countryCode ?? null,
      redeemerCountry: params.redeemerCountry,
    });

    return referral;
  },

  /** Click/signup funnel for one user's code. */
  async statsFor(userId: number): Promise<{
    clicks: number;
    signups: number;
    countriesReached: string[];
  }> {
    const [codeRow] = await db
      .select({ id: referralCodes.id })
      .from(referralCodes)
      .where(and(eq(referralCodes.userId, userId), eq(referralCodes.isActive, true)))
      .limit(1);

    const [clickRow] = codeRow
      ? await db.select({ n: count() }).from(referralClicks).where(eq(referralClicks.codeId, codeRow.id))
      : [{ n: 0 }];

    const direct = await db
      .select({ redeemerCountry: referrals.redeemerCountry })
      .from(referrals)
      .where(and(eq(referrals.referrerUserId, userId), eq(referrals.status, 'active')));

    return {
      clicks: clickRow.n,
      signups: direct.length,
      countriesReached: [...new Set(direct.map((d) => d.redeemerCountry).filter((c): c is string => !!c))].sort(),
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
      referrerUserId: number;
      depth: number;
      signedUpAt: Date;
    }[]
  > {
    const rootDepth = await db
      .select({ depth: referrals.depth })
      .from(referrals)
      .where(eq(referrals.referredUserId, userId))
      .limit(1);

    // Depths are absolute (distance from the tree's root), so a subtree query
    // has to offset by where this user sits, or `maxDepth` would mean something
    // different for a root than for someone six levels down.
    const base = rootDepth[0]?.depth ?? 0;

    return db
      .select({
        referredUserId: referrals.referredUserId,
        name: users.name,
        countryCode: users.countryCode,
        referrerUserId: referrals.referrerUserId,
        depth: referrals.depth,
        signedUpAt: referrals.signedUpAt,
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
};
