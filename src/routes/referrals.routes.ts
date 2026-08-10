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
 * The caller's own standing: click/signup funnel, points broken down by how
 * they were earned, whether they've closed a circuit, and which countries their
 * code has reached. Deliberately no identities of the people they referred.
 *
 * Returns 200: { clicks, signups, countriesReached, points, pointsByKind, hasCircuit, country }
 */
router.get('/me/stats', wrap(referralsController.stats));

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
