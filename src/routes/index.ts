import { Router, Request, Response } from 'express';
import { apiLimiter } from '../middleware/rate-limit.middleware';
import authRoutes from './auth.routes';
import booksRoutes from './books.routes';
import booksV2Routes from './books.v2.routes';
import authorsRoutes from './authors.routes';
import recommendationsRoutes from './recommendations.routes';
import guestRoutes from './guest.routes';
import genresRoutes from './genres.routes';
import userBooksRoutes from './user-books.routes';
import userSettingsRoutes from './user-settings.routes';
import emailChangeRoutes from './email-change.routes';
import communityRoutes from './community.routes';
import usersRoutes from './users.routes';
import exploreRoutes from './explore.routes';
import subscriptionRoutes from './subscriptions.routes';
import notificationPreferencesRoutes from './notification-preferences.routes';
import preferenceHistoryRoutes from './preference-history.routes';
import unsubscribeRoutes from './unsubscribe.routes';
import contactRoutes from './contact.routes';
import settingsRoutes from './settings.routes';
import notificationsRoutes from './notifications.routes';
import deviceTokensRoutes from './device-tokens.routes';
import reportsRoutes from './reports.routes';
import referralsRoutes from './referrals.routes';
import paymentsRoutes from './payments.routes';
import cartRoutes from './cart.routes';
import ordersRoutes from './orders.routes';
import savedBooksRoutes from './saved-books.routes';

const router = Router();

// Health check sits outside versioning and rate limiting
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'kinkane-server' });
});

// v1 — apply general rate limit to all v1 routes
const v1 = Router();
v1.use(apiLimiter);
v1.use('/auth', authRoutes);
v1.use('/books', booksRoutes);
v1.use('/authors', authorsRoutes);
v1.use('/genres', genresRoutes);
v1.use('/recommendations', recommendationsRoutes);
v1.use('/guest-sessions', guestRoutes);
v1.use('/user-books', userBooksRoutes);
v1.use('/user/settings', userSettingsRoutes);
v1.use('/user/email-change', emailChangeRoutes);
v1.use('/community', communityRoutes);
v1.use('/users', usersRoutes);
v1.use('/explore', exploreRoutes);
v1.use('/user/subscription', subscriptionRoutes);
v1.use('/user/notification-preferences', notificationPreferencesRoutes);
v1.use('/user/preference-history', preferenceHistoryRoutes);
v1.use('/user/notifications', notificationsRoutes);
v1.use('/user/device-tokens', deviceTokensRoutes);
v1.use('/reports', reportsRoutes);
// Open to every signed-up user — the router itself deliberately applies
// requireAuth without requirePlus. See referrals.routes.ts.
v1.use('/referrals', referralsRoutes);
// Payment confirmation by reference — covers subscriptions and book orders alike.
v1.use('/payments', paymentsRoutes);
// The shop. Deliberately requireAuth only, with no requirePlus anywhere —
// buying is open to every signed-up user.
v1.use('/cart', cartRoutes);
v1.use('/orders', ordersRoutes);
// The shop's purchase wishlist. requireAuth only — never requirePlus.
v1.use('/saved-books', savedBooksRoutes);
v1.use('/unsubscribe', unsubscribeRoutes);
// Public by design — the people most likely to need the contact form are the
// ones who cannot get into their account.
v1.use('/contact', contactRoutes);
// Storefront-wide copy the admin console controls. Public: it is what every
// visitor sees anyway.
v1.use('/settings', settingsRoutes);

router.use('/v1', v1);

// v2 — one endpoint, not a second copy of the API.
//
// Only GET /books differs between the versions (v2 takes `type`, v1 does not and rejects
// it), so only that route is mounted here. Everything else stays on v1: duplicating routes
// that behave identically would create pairs to keep in step, and the first divergence
// would be an accident rather than a decision. See books.v2.routes.ts.
//
// The same apiLimiter *instance* is reused, deliberately: it keeps one counter per client
// across both versions, so moving a search from v1 to v2 does not hand that client a second
// budget. A fresh limiter here would have doubled every caller's allowance.
const v2 = Router();
v2.use(apiLimiter);
v2.use('/books', booksV2Routes);

router.use('/v2', v2);

export default router;
