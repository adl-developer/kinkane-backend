import { Request, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { referralsService, SHARE_CHANNELS } from '../services/referrals.service';
import { referralScoringService } from '../services/referral-scoring.service';
import { referralAnalyticsService } from '../services/referral-analytics.service';
import { geoService } from '../services/geo.service';
import { enqueueEmail } from '../lib/email-queue';
import { config } from '../config';
import { logger } from '../lib/logger';
import { parseId } from '../lib/route-helpers';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const inviteSchema = z.object({
  email: z.string().email(),
});

const voidSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

const referralCodeField = z.string().trim().regex(/^[0-9A-Za-z]{6,32}$/, 'Invalid referral code');

/**
 * `referralCode` is the field name across every endpoint that accepts one —
 * signup, social login, and parking a code on a guest session all already used
 * it, and this endpoint was the lone holdout calling it `code`.
 *
 * `code` is still accepted, and deliberately so: this endpoint is called by
 * *installed* mobile apps on launch, and a shipped build cannot be updated
 * retroactively. Renaming without the alias would silently stop counting clicks
 * from every app already in the wild — and because the endpoint answers 202
 * regardless, nothing would look broken while the number quietly went to zero.
 *
 * Drop the alias once the oldest supported build sends `referralCode`.
 */
export const clickSchema = z
  .object({
    referralCode: referralCodeField.optional(),
    /** @deprecated Use `referralCode`. Retained for already-shipped app builds. */
    code: referralCodeField.optional(),
    channel: z.enum(['whatsapp', 'sms', 'email', 'copy', 'link', 'app']).optional(),
  })
  .refine((b) => b.referralCode ?? b.code, {
    message: 'referralCode is required',
    path: ['referralCode'],
  })
  .transform((b) => ({ referralCode: (b.referralCode ?? b.code) as string, channel: b.channel }));

const shareSchema = z.object({
  channel: z.enum(SHARE_CHANNELS),
});

const countrySchema = z.object({
  // Two letters, and nothing further: a code the seed doesn't carry is stored
  // as-is and simply scores nothing, which is the same treatment a geolocated
  // one gets. Validating against the country table here would make an admin
  // unable to record a real place we happen not to list.
  countryCode: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/),
});

async function nameOf(userId: number): Promise<string> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name ?? 'A friend';
}

export const referralsController = {
  /** GET /api/v1/referrals/me — the caller's link and share payloads. */
  async me(req: AuthenticatedRequest, res: Response): Promise<void> {
    const [{ code }, name] = await Promise.all([
      referralsService.getOrCreateCode(req.user.id),
      nameOf(req.user.id),
    ]);

    res.status(200).json({
      code,
      ...referralsService.buildSharePayloads(code, name),
      videoUrl: config.referrals.videoUrl,
    });
  },

  /** POST /api/v1/referrals/me/rotate — new code, old one revoked. */
  async rotate(req: AuthenticatedRequest, res: Response): Promise<void> {
    const [{ code }, name] = await Promise.all([
      referralsService.rotateCode(req.user.id),
      nameOf(req.user.id),
    ]);

    res.status(200).json({
      code,
      ...referralsService.buildSharePayloads(code, name),
      videoUrl: config.referrals.videoUrl,
    });
  },

  /**
   * GET /api/v1/referrals/me/stats — the caller's own competition standing.
   *
   * Counts and countries only — no identities. Identities now live on
   * /me/network, at a deliberate redaction: first name plus last initial, city,
   * and nothing that identifies an account. That is a narrowing of an earlier
   * position that referees should not be surfaced to their referrer at all, and
   * it was taken knowingly — the journey map is the feature, and a map of
   * anonymous dots is not one.
   */
  async stats(req: AuthenticatedRequest, res: Response): Promise<void> {
    const [funnel, score, user] = await Promise.all([
      referralsService.statsFor(req.user.id),
      referralScoringService.scoreFor(req.user.id),
      db.select({ countryCode: users.countryCode }).from(users).where(eq(users.id, req.user.id)).limit(1),
    ]);

    res.status(200).json({
      ...funnel,
      points: score.total,
      pointsByKind: score.byKind,
      hasCircuit: score.hasCircuit,
      country: user[0]?.countryCode ?? null,
    });
  },

  /**
   * GET /api/v1/referrals/me/network — the caller's journey map and globe data.
   *
   * Separate from /me/stats rather than folded into it. Stats is a handful of
   * counters every screen in the feature reads; this walks a whole subtree and
   * is only ever wanted by the two map screens. Merging them would make the
   * cheap call pay for the expensive one on every render.
   *
   * Names are redacted to "Amara S." in the service, not here — see redactName.
   */
  async network(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.status(200).json(await referralsService.networkFor(req.user.id));
  },

  /**
   * GET /api/v1/referrals/analytics — campaign-wide figures. Public.
   *
   * Unauthenticated by decision: the campaign's momentum is the marketing, and
   * every figure here is an aggregate. The only people named are the top
   * referrers, at the same first-name-only redaction the public leaderboard
   * already uses.
   */
  async analytics(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await referralAnalyticsService.campaign());
  },

  /**
   * GET /api/v1/referrals/map — anonymous city pins. Public.
   *
   * The globe's "Others' referrals" layer: where the campaign has reached, with
   * a count per city and no identities at all.
   */
  async map(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ pins: await referralAnalyticsService.cityPins() });
  },

  /** GET /api/v1/referrals/leaderboard — public standings. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const rows = await referralScoringService.leaderboard(limit);

    res.status(200).json({
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        // First name only — a leaderboard is a public surface, and a full name
        // plus a country is a great deal more identifying than a rank needs.
        name: r.name.split(' ')[0],
        country: r.countryCode,
        points: r.points,
      })),
    });
  },

  /** POST /api/v1/referrals/invite — send the invite by email. */
  async invite(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const [{ code }, name] = await Promise.all([
      referralsService.getOrCreateCode(req.user.id),
      nameOf(req.user.id),
    ]);

    await enqueueEmail('referral-invite', {
      to: parsed.data.email,
      referrerName: name,
      link: referralsService.buildReferralLink(code, name, 'email'),
    });

    // Recorded after the email is queued, so "Sent" never counts an invite the
    // queue rejected. Best-effort in the other direction too: a failure to
    // record must not make the caller think the invite didn't go out, because
    // it did.
    try {
      await referralsService.recordInvite(req.user.id, parsed.data.email);
    } catch (err) {
      logger.warn('Failed to record referral invite', { error: (err as Error).message });
    }

    // 202, not 200: the email is queued, not sent. Reporting success for a job
    // that hasn't run yet would be a lie the client can't check.
    res.status(202).json({ queued: true });
  },

  /**
   * POST /api/v1/referrals/shares — the user tapped WhatsApp, SMS or Copy.
   *
   * The soft half of the "Sent" figure. This server never learns whether
   * anything was actually sent on these channels, only that the user opened the
   * share sheet — which is still the difference between a screen that reads
   * "Sent 0" and one that reflects how people really share a link.
   *
   * 202, not 201: what is being recorded is an intention, and a stronger status
   * would overstate what we know.
   */
  async recordShare(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = shareSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    await referralsService.recordShare(req.user.id, parsed.data.channel);
    res.status(202).json({ recorded: true });
  },

  /**
   * GET /r/:code/:slug — public redirect, and where clicks are counted.
   *
   * The slug is read but never used to resolve anything; it exists so the link
   * carries the referrer's name. Unknown and revoked codes redirect to the plain
   * homepage rather than 404ing — a 404 would confirm which codes exist.
   */
  async redirect(req: Request, res: Response): Promise<void> {
    const code = String(req.params.code ?? '');
    const channel = typeof req.query.c === 'string' ? req.query.c : undefined;

    const resolved = await referralsService.resolveCode(code);
    if (!resolved) {
      res.redirect(302, config.appUrl);
      return;
    }

    const country = await geoService.resolveFromRequest(req);
    const clickId = await referralsService.logClick({
      codeId: resolved.id,
      channel,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      countryCode: country.code,
    });

    // The code travels in the query string so the landing page can put it in
    // the signup form, and in a cookie so it survives a user who wanders around
    // the site before creating an account. Lax rather than Strict: the whole
    // point is that this arrives via a link from WhatsApp or an email client,
    // which is exactly the cross-site navigation Strict drops.
    res.cookie('kk_ref', code.toUpperCase(), {
      maxAge: 90 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
    });

    const target = new URL('/invite', config.appUrl);
    target.searchParams.set('ref', code.toUpperCase());
    if (channel) target.searchParams.set('c', channel);
    if (clickId) target.searchParams.set('cid', String(clickId));

    res.redirect(302, target.toString());
  },

  /**
   * POST /api/v1/referrals/clicks — record a click the redirect never saw.
   *
   * This exists because of how universal links actually behave. When iOS or
   * Android opens the app from a `/r/...` link, **no HTTP request is made** —
   * the domain-association file was fetched at install time, so the OS matches
   * the path locally and hands the URL straight to the app. The server never
   * sees the tap.
   *
   * Without this endpoint, `clicks` quietly degrades into "people who don't have
   * the app" as installs grow. Signups still attribute correctly, so nothing
   * looks broken — a referrer whose friends all have the app would just show 0
   * clicks and 5 signups, and the funnel would read as a conversion miracle
   * rather than a measurement gap.
   *
   * Unauthenticated by design: the tap happens before there is an account, which
   * is the whole point of a referral.
   *
   * Always answers 202, whether or not the code resolved. Reporting "unknown
   * code" would turn this into an oracle for testing which codes exist — the
   * same reason the redirect sends unknown codes to the homepage instead of
   * 404ing.
   */
  async recordClick(req: Request, res: Response): Promise<void> {
    const parsed = clickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const resolved = await referralsService.resolveCode(parsed.data.referralCode);

    if (resolved) {
      const country = await geoService.resolveFromRequest(req);
      await referralsService.logClick({
        codeId: resolved.id,
        channel: parsed.data.channel,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        countryCode: country.code,
      });
    }

    // Deliberately not { recorded: true } — that would be a claim this response
    // can't honestly make for an unknown code.
    res.status(202).json({ ok: true });
  },

  // ── Admin ───────────────────────────────────────────────────────────────────

  /** GET /admin/referrals/tree?userId=&depth= — the map. */
  async adminTree(req: Request, res: Response): Promise<void> {
    const userId = parseId(String(req.query.userId ?? ''), 'userId');
    const depth = req.query.depth ? Number(req.query.depth) : undefined;

    const nodes = await referralsService.treeFor(userId, depth);
    res.status(200).json({ userId, nodes });
  },

  /** GET /admin/referrals/leaderboard — full standings, unredacted. */
  async adminLeaderboard(req: Request, res: Response): Promise<void> {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.status(200).json({ leaderboard: await referralScoringService.leaderboard(limit) });
  },

  /** POST /admin/referrals/:id/void — void a referral and its direct points. */
  async adminVoid(req: Request, res: Response): Promise<void> {
    const id = parseId(req.params.id, 'referral id');
    const parsed = voidSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    await referralScoringService.voidReferral(id, parsed.data.reason);
    res.status(200).json({ voided: true });
  },

  /**
   * PATCH /admin/users/:id/country — correct a mis-geolocated user.
   *
   * Admin-only, deliberately. Someone in Ghana whose ISP geolocates to the UK is
   * a certainty, and that is a competition dispute rather than a bug — but a
   * self-service country field would make the whole geolocation exercise
   * pointless.
   *
   * Note what this does NOT do: past referrals keep the country they snapshotted
   * at redemption, so points already awarded stand. Rescoring history would mean
   * re-deriving every referral this user is party to, in both directions, plus
   * every circuit that touched them. That is a real piece of work and it should
   * be deliberate, not a side effect of fixing a typo.
   */
  async adminSetCountry(req: Request, res: Response): Promise<void> {
    const id = parseId(req.params.id, 'user id');
    const parsed = countrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const countryCode = parsed.data.countryCode.toUpperCase();
    const updated = await db
      .update(users)
      .set({ countryCode, countrySource: 'admin', countryResolvedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id });

    if (updated.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    logger.info('User country corrected by admin', { userId: id, countryCode });
    res.status(200).json({ userId: id, countryCode, rescored: false });
  },
};
