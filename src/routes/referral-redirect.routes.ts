import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';
import { referralsController } from '../controllers/referrals.controller';
import { wrap } from '../lib/route-helpers';

const sendCommand = (...args: string[]) =>
  (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<import('rate-limit-redis').RedisReply>;

// This is the only unauthenticated endpoint in the feature that writes to the
// database (one click row per hit), and it sits on a public URL people paste
// into group chats. 120 per 15 minutes per IP absorbs a link genuinely going
// round a WhatsApp group while still bounding what a script can insert.
const redirectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests — please try again later' }),
  store: new RedisStore({ prefix: 'rl:referral-redirect:', sendCommand }),
});

const router = Router();

/**
 * GET /r/:code/:slug
 *
 * The public referral link. Mounted at the root rather than under /api/v1
 * because it is a link a person sees, sends and taps — versioning it would put
 * "/api/v1" in the middle of something shared over SMS.
 *
 * The trailing slug carries the referrer's name and is never used to resolve
 * anything; lookup is by code alone, which is what lets a user rename themselves
 * without breaking links already sent. Unknown or revoked codes redirect to the
 * homepage rather than 404ing, so the endpoint can't be used to test which codes
 * exist.
 *
 * Query: c — optional channel tag (whatsapp | sms | email | copy)
 * Always 302 — to the invite landing page on a hit, to the homepage otherwise.
 */
router.get('/:code/:slug', redirectLimiter, wrap(referralsController.redirect));

// Same link with the slug left off. Worth supporting: the slug is decorative,
// and a link that loses its last path segment to a chat client's URL detection
// should still work.
router.get('/:code', redirectLimiter, wrap(referralsController.redirect));

export default router;
