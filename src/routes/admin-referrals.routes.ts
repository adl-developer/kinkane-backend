import { Router } from 'express';
import { referralsController } from '../controllers/referrals.controller';
import { wrap } from '../lib/route-helpers';

/**
 * Admin surface for the referral competition. Mounted in app.ts behind the same
 * static bearer token as Bull Board and the Gardners dropship routes, and
 * outside /api/v1 for the same reason those are: it is operator tooling, not
 * part of the client contract.
 */
const router = Router();

/**
 * GET /admin/referrals/tree?userId=&depth=
 *
 * The referral map: everyone below a user, direct and indirect, at any depth.
 * `depth` trims the response for rendering — it has never limited what is
 * tracked.
 *
 * Returns 200: { userId, nodes: [{ referredUserId, name, countryCode, referrerUserId, depth, signedUpAt }] }
 */
router.get('/tree', wrap(referralsController.adminTree));

/**
 * GET /admin/referrals/leaderboard?limit=
 *
 * Standings with full names, unlike the public leaderboard.
 */
router.get('/leaderboard', wrap(referralsController.adminLeaderboard));

/**
 * POST /admin/referrals/:id/void
 *
 * Voids a referral and the direct points it produced. Circuit awards are left
 * standing — see referralScoringService.voidReferral for why that is a
 * deliberate limitation rather than an oversight.
 *
 * Body: { reason: string }
 */
router.post('/:id/void', wrap(referralsController.adminVoid));

export default router;
