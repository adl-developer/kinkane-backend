import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';
import { requireAuth } from '../middleware/auth.middleware';
import { referralsController } from '../controllers/referrals.controller';
import { wrap } from '../lib/route-helpers';

const sendCommand = (...args: string[]) =>
  (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<import('rate-limit-redis').RedisReply>;

// Sending mail on someone else's behalf is the one endpoint here that can be
// turned into a spam cannon, so it gets its own budget: 20 invites an hour is
// generous for a person and useless for a script.
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many invites — please try again later' }),
  store: new RedisStore({ prefix: 'rl:referral-invite:', sendCommand }),
});

// Matches the budget on the /r redirect, since it is the same event arriving by
// a different route — an app-opened tap and a browser-opened tap should not have
// different allowances just because the OS swallowed the HTTP request.
const clickLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests — please try again later' }),
  store: new RedisStore({ prefix: 'rl:referral-click-report:', sendCommand }),
});

// A share is one row per tap and needs no recipient, so it is the cheapest row
// in this feature to manufacture. Generous enough that nobody sharing in
// earnest will ever see it; tight enough that a loop can't inflate someone's
// "Sent" figure into the thousands overnight.
const shareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many shares — please try again later' }),
  store: new RedisStore({ prefix: 'rl:referral-share:', sendCommand }),
});

// The two public campaign endpoints. Cached for five minutes apiece, so this
// budget is not about database load — it is about the bandwidth and the Redis
// round trip, both of which are still free to anyone with a loop. Generous
// enough that a page refreshing its charts will never see it.
const campaignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests — please try again later' }),
  store: new RedisStore({ prefix: 'rl:referral-campaign:', sendCommand }),
});

const router = Router();

/**
 * GET /api/v1/referrals/leaderboard
 *
 * Public "Around the World" standings — rank, first name, country, points.
 * Unauthenticated: the leaderboard is a marketing surface as much as a feature.
 *
 * Query: limit — optional, default 50, capped at 100
 * Returns 200: { leaderboard: [{ rank, name, country, points }] }
 */
router.get('/leaderboard', wrap(referralsController.leaderboard));

/**
 * GET /api/v1/referrals/analytics
 *
 * Campaign-wide performance: totals, one weekly bucket per week of the campaign
 * for the sent/converted and cumulative charts, and the top referrers ranked by
 * signups.
 *
 * Unauthenticated, like the leaderboard — every figure is an aggregate, and the
 * only people named are top referrers at first-name-only redaction.
 *
 * `weekly` is anchored to REFERRAL_CAMPAIGN_STARTS_AT, not to today: it runs
 * from week 1 of the competition through the week in progress, so it grows by
 * an entry a week and a given weekNumber always means the same dates.
 *
 * Returns 200: { totals: { sent, clicks, signups, successful, conversionRate,
 *   countries, continents }, weekly: [{ weekNumber, weekStart, weekEnd, sent,
 *   converted, cumulative }], topReferrers: [{ rank, name, country, signups,
 *   points }] }
 */
router.get('/analytics', campaignLimiter, wrap(referralsController.analytics));

/**
 * GET /api/v1/referrals/map
 *
 * Anonymous city pins for the globe's "Others' referrals" layer — where the
 * campaign has reached, with a headcount per city and no identities at all.
 * Cities with no coordinates are omitted rather than dropped at (0, 0).
 *
 * Returns 200: { pins: [{ city, countryCode, lat, lng, count }] }
 */
router.get('/map', campaignLimiter, wrap(referralsController.map));

/**
 * POST /api/v1/referrals/clicks
 *
 * Records a referral-link tap that the `/r/...` redirect never saw.
 *
 * When a universal link (iOS) or app link (Android) opens the app directly, the
 * OS resolves the path locally and makes no HTTP request — so the server has no
 * idea the link was tapped. The app calls this instead, once, when it launches
 * from a referral link.
 *
 * Unauthenticated: the tap happens before there is an account. Rate limited
 * because it is public and writes a row.
 *
 * Body: { referralCode: string, channel?: 'whatsapp' | 'sms' | 'email' | 'copy' | 'link' | 'app' }
 *   `code` is still accepted as a deprecated alias for already-shipped app builds.
 * Returns 202: { ok: true } — always, whether or not the code exists, so this
 *   cannot be used to probe which codes are real.
 * Errors: 400 malformed code | 429 rate limited
 */
router.post('/clicks', clickLimiter, wrap(referralsController.recordClick));

// Everything below needs a logged-in user.
//
// requireAuth ONLY — never requirePlus. Referral is open to every signed-up
// account including gated (trial-expired, read-only) ones, and both minting a
// code and sending an invite are writes. Putting a Plus gate in front of this
// router, or letting a future blanket write-gate sweep it in, would silently
// take the competition away from exactly the users it is meant to bring back.
router.use(requireAuth);

/**
 * GET /api/v1/referrals/me
 *
 * The caller's referral link and prebuilt share payloads. The code is minted on
 * first call and stable from then on.
 *
 * Returns 200: { code, link, message, whatsapp, sms, email: { subject, body, mailto }, copy, videoUrl }
 */
router.get('/me', wrap(referralsController.me));

/**
 * POST /api/v1/referrals/me/rotate
 *
 * Issues a new code and revokes the old one — for when a link has been shared
 * somewhere the user regrets. Referrals already attributed are unaffected.
 *
 * Returns 200: same shape as GET /me
 */
router.post('/me/rotate', wrap(referralsController.rotate));

/**
 * GET /api/v1/referrals/me/stats
 *
 * The caller's own standing: the invite funnel, points broken down by how they
 * were earned, whether they've closed a circuit, and which countries their code
 * has reached. Deliberately no identities of the people they referred — for
 * those, see /me/network.
 *
 * `sent` counts invites and shares this user initiated; `successful` and
 * `pending` count people who arrived and whether their email is verified yet.
 * The three do not reconcile, and are not meant to: a forwarded link produces a
 * signup with no send behind it. See referralsService.statsFor.
 *
 * Returns 200: { clicks, signups, sent, successful, pending, countriesReached,
 *   points, pointsByKind, hasCircuit, country }
 */
router.get('/me/stats', wrap(referralsController.stats));

/**
 * POST /api/v1/referrals/shares
 *
 * Records that the caller opened a share sheet — WhatsApp, SMS, or a copied
 * link. Feeds the `sent` figure alongside emailed invites.
 *
 * Body: { channel: 'whatsapp' | 'sms' | 'copy' | 'link' }
 * Returns 202: { recorded: true }
 */
router.post('/shares', shareLimiter, wrap(referralsController.recordShare));

/**
 * GET /api/v1/referrals/me/network
 *
 * The caller's journey map and globe data: every person below them, plus the
 * summary the screens display.
 *
 * Names are redacted to first name plus last initial — "Amara S." — and no
 * response field identifies an account beyond an opaque id used only to draw
 * edges between nodes.
 *
 * Kept separate from /me/stats because it walks a whole subtree and only the
 * two map screens ever want it.
 *
 * Returns 200: {
 *   summary: { directReferrals, networkTotal, degreesOfInfluence, citiesReached,
 *     countriesReached, byDegree: [{ degree, count }],
 *     longestChain: { links, hops: [{ name, city, countryCode }] } },
 *   nodes: [{ id, name, city, countryCode, lat, lng, referrerId, degree,
 *     directReferrals, signedUpAt, credited }]
 * }
 */
router.get('/me/network', wrap(referralsController.network));

/**
 * POST /api/v1/referrals/invite
 *
 * Emails the caller's invite link to one address.
 *
 * Body: { email: string }
 * Returns 202: { queued: true }   — queued, not yet delivered
 * Errors: 400 invalid email | 401 unauthenticated | 429 rate limited
 */
router.post('/invite', inviteLimiter, wrap(referralsController.invite));

export default router;
