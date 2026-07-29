import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { preferenceHistoryController } from '../controllers/preference-history.controller';

const router = Router();

/**
 * GET /api/v1/user/preference-history
 *
 * Returns the authenticated user's preference timeline, newest first. Each
 * entry is a full snapshot of their taste profile at that point in time, plus
 * `changedFields` naming what differed from the previous entry.
 *
 * A user can only read their own history — there is no path to anyone else's.
 *
 * Query (optional): { limit? (1-100, default 20), offset? (default 0) }
 * Returns 200: { preferenceHistory: [{ id, feelings, bookIds, genres, dislikes,
 *   readerType, changedFields, source, recordedAt }],
 *   pagination: { total, limit, offset, hasMore } }
 * Errors: 400 invalid query | 401 unauthenticated
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  preferenceHistoryController.list(req as AuthenticatedRequest, res),
);

export default router;
