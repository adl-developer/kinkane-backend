import { Request, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { referralsService } from '../services/referrals.service';
import { referralScoringService } from '../services/referral-scoring.service';
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
   * Counts and countries only. Who specifically signed up under someone is not
   * theirs to see: a referee never consented to having their account surfaced to
   * whoever shared a link with them.
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
      videoUrl: config.referrals.videoUrl,
    });

    // 202, not 200: the email is queued, not sent. Reporting success for a job
    // that hasn't run yet would be a lie the client can't check.
    res.status(202).json({ queued: true });
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
