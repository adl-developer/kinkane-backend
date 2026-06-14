import { Router, Request, Response } from 'express';
import { apiLimiter } from '../middleware/rate-limit.middleware';
import authRoutes from './auth.routes';
import booksRoutes from './books.routes';
import recommendationsRoutes from './recommendations.routes';
import guestRoutes from './guest.routes';
import genresRoutes from './genres.routes';
import userBooksRoutes from './user-books.routes';
import userSettingsRoutes from './user-settings.routes';
import emailChangeRoutes from './email-change.routes';
import communityRoutes from './community.routes';
import usersRoutes from './users.routes';

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
v1.use('/genres', genresRoutes);
v1.use('/recommendations', recommendationsRoutes);
v1.use('/guest-sessions', guestRoutes);
v1.use('/user-books', userBooksRoutes);
v1.use('/user/settings', userSettingsRoutes);
v1.use('/user/email-change', emailChangeRoutes);
v1.use('/community', communityRoutes);
v1.use('/users', usersRoutes);

router.use('/v1', v1);

export default router;
