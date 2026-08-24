import { Router } from 'express';
import { requireAdmin } from '../../middleware/admin-auth.middleware';
import { loginLimiter } from '../../middleware/rate-limit.middleware';
import { wrapHttp } from '../../lib/route-helpers';
import { adminController } from '../../controllers/admin/admin.controller';

const router = Router();

/**
 * The admin console API.
 *
 * Mounted at `/admin/console` rather than under `/api/v1`, alongside the other
 * `/admin/*` surfaces. It is not the customer API and is not versioned with it:
 * the console ships with the server and the two move together.
 *
 * Everything except the login is behind `requireAdmin`, which is a *person's*
 * session — distinct from the static `ADMIN_TOKEN` guarding the machine-facing
 * surfaces (Bull Board, Gardners dropship, referral corrections).
 */

// ── Session ───────────────────────────────────────────────────────────────────
// Rate limited with the same bucket as customer login: this is a password form
// on the public internet and the accounts behind it can export the customer list.
router.post('/auth/login', loginLimiter, wrapHttp(adminController.login));
router.get('/auth/me', requireAdmin, wrapHttp(adminController.me));

// Everything below needs a session.
router.use(requireAdmin);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', wrapHttp(adminController.dashboard));
// The sidebar badges. One call rather than one per badge.
router.get('/badges', wrapHttp(adminController.badges));

// ── Orders ────────────────────────────────────────────────────────────────────
// Read-only by design: the screens have no action controls, so there is no
// endpoint to change a status, refund, or resend anything. Adding one later is
// a deliberate decision rather than an accident of scaffolding.
router.get('/orders', wrapHttp(adminController.orders));
router.get('/orders/export', wrapHttp(adminController.ordersExport));

// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', wrapHttp(adminController.customers));
router.get('/customers/export', wrapHttp(adminController.customersExport));
router.post('/customers/:id/blacklist', wrapHttp(adminController.blacklistCustomer));
router.delete('/customers/:id/blacklist', wrapHttp(adminController.unblacklistCustomer));

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports', wrapHttp(adminController.reports));
router.post('/reports/:id/dismiss', wrapHttp(adminController.dismissReport));
// Blocks the reported account and closes every pending report against them.
router.post('/reports/:id/blacklist', wrapHttp(adminController.blacklistFromReport));

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings/banners', wrapHttp(adminController.banners));
router.put('/settings/banners', wrapHttp(adminController.updateBanners));

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', wrapHttp(adminController.notifications));
router.post('/notifications/read-all', wrapHttp(adminController.markNotificationsRead));
router.delete('/notifications', wrapHttp(adminController.clearNotifications));

export default router;
