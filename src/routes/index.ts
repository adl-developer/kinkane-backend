import { Router, Request, Response } from 'express';
import { apiLimiter } from '../middleware/rate-limit.middleware';
import authRoutes from './auth.routes';
import booksRoutes from './books.routes';
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

router.use('/v1', v1);

export default router;
