import { Router, Request, Response } from 'express';
import { config } from '../config';

const router = Router();

/**
 * GET /redirect/* — the browser side of an app link.
 *
 * Every link meant to open the app is sent as `APP_URL/redirect/<path>` (see
 * lib/app-link). On a phone with the app installed the OS matches `/redirect/*`
 * against the association file and opens the app without making this request.
 * Everywhere else — no app, a desktop, a webmail preview — the request lands
 * here and is forwarded to `/<path>` on the web client, query string intact, so
 * the link still does what it says.
 *
 * `/redirect/r/*` never reaches this handler: referral links are mounted ahead
 * of it in app.ts so the click is still counted.
 *
 * The target is built by setting only the path and query on `APP_URL`, never by
 * resolving the incoming string against it. `/redirect//evil.com` would
 * otherwise resolve to a protocol-relative URL and turn this into an open
 * redirect on the Kinkané domain.
 *
 * Always 302 and never cached: `/reset-password` and `/cancel-email-change`
 * carry single-use tokens, and a cached redirect would replay one.
 */
router.get('*', (req: Request, res: Response) => {
  const target = new URL(config.appUrl);
  target.pathname = `/${req.path.replace(/^\/+/, '')}`;
  target.search = new URL(req.originalUrl, 'http://placeholder').search;

  res.set('Cache-Control', 'no-store');
  res.redirect(302, target.toString());
});

export default router;
