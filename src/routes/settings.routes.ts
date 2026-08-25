import { Router, Request, Response } from 'express';
import { wrapHttp } from '../lib/route-helpers';
import { adminSettingsService } from '../services/admin/settings.service';

const router = Router();

/**
 * GET /api/v1/settings/banners
 *
 * The announcement strips the storefront renders at the top of every page.
 * Public and unauthenticated — it is the same copy every visitor sees.
 *
 * Only **enabled** banners come back. A storefront has no business knowing the
 * text of a banner it is not showing, and returning the disabled ones would
 * invite a client to cache one and render it after it was switched off.
 *
 * The admin console has its own version of this that returns both slots with
 * their toggle state, because it has to draw the switches.
 *
 * Returns 200: { banners: [{ slot: 'top' | 'second', text }] }
 */
router.get(
  '/banners',
  wrapHttp(async (_req: Request, res: Response) => {
    res.status(200).json({ banners: await adminSettingsService.publicBanners() });
  }),
);

export default router;
