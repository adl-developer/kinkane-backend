import { Router, Request, Response } from 'express';
import { apiLimiter } from '../middleware/rate-limit.middleware';
import authRoutes from './auth.routes';
import booksRoutes from './books.routes';

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

router.use('/v1', v1);

export default router;
