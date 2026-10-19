import { Router } from 'express';
import { requireAdmin } from '../../middleware/admin-auth.middleware';
import {
  adminLoginLimiter,
  adminPasswordResetLimiter,
  adminPasswordResetEmailLimiter,
} from '../../middleware/rate-limit.middleware';
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
 * Everything except signing in and resetting a forgotten password is behind
 * `requireAdmin`, which is a *person's* session — distinct from the static
 * `ADMIN_TOKEN` guarding the machine-facing surfaces (Bull Board, Gardners
 * dropship, referral corrections).
 */

// ── Session ───────────────────────────────────────────────────────────────────
// Rate limited in its own bucket — sharing the customer one would let a brute
// force against the app lock staff out of the console.
router.post('/auth/login', adminLoginLimiter, wrapHttp(adminController.login));
router.get('/auth/me', requireAdmin, wrapHttp(adminController.me));
// Rate limited with the login bucket: it takes the current password, so it is
// another place someone can guess one.
router.post(
  '/auth/change-password',
  adminLoginLimiter,
  requireAdmin,
  wrapHttp(adminController.changePassword),
);
// Forgotten password. Both public, so both rate limited, in a bucket of their
// own so reset traffic cannot use up the login quota. Asking for a link is also
// limited per target address: it sends mail to whatever address it is given.
router.post(
  '/auth/forgot-password',
  adminPasswordResetLimiter,
  adminPasswordResetEmailLimiter,
  wrapHttp(adminController.forgotPassword),
);
router.post('/auth/reset-password', adminPasswordResetLimiter, wrapHttp(adminController.resetPassword));

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

// Postage charged against postage paid. Read-only, and the numbers are
// recomputed on the fly rather than stored, so it is safe to refresh.
router.get('/shipping-margin', wrapHttp(adminController.shippingMargin));

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

// ── Referrals ─────────────────────────────────────────────────────────────────
// Read-only. Corrections (voiding a referral, fixing a country) stay on the
// token-guarded /admin/referrals surface.
router.get('/referrals/analytics', wrapHttp(adminController.referralAnalytics));
router.get('/referrals/travellers', wrapHttp(adminController.referralTravellers));

// ── Restock requests ──────────────────────────────────────────────────────────
// "Request Restock" presses from the shop. Marking one fulfilled changes nothing
// but its status: the admin arranges the restock and contacts the customer
// themselves.
router.get('/restock-requests', wrapHttp(adminController.restockRequests));
router.get('/restock-requests/export', wrapHttp(adminController.restockRequestsExport));
router.post('/restock-requests/:id/fulfil', wrapHttp(adminController.fulfilRestockRequest));
router.post('/restock-requests/:id/reopen', wrapHttp(adminController.reopenRestockRequest));
// "Fulfil all" on a card: every pending request for one edition.
router.post('/restock-requests/books/:bookId/fulfil', wrapHttp(adminController.fulfilRestockRequestsForBook));

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings/banners', wrapHttp(adminController.banners));
router.put('/settings/banners', wrapHttp(adminController.updateBanners));

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', wrapHttp(adminController.notifications));
router.post('/notifications/read-all', wrapHttp(adminController.markNotificationsRead));
router.delete('/notifications', wrapHttp(adminController.clearNotifications));

export default router;
