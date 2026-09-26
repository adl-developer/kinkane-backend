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
 * Query (optional): { limit? (1-100, default 20), offset? (default 0),
 *   field? — only entries where this field changed, plus the baseline entry }
 * Returns 200: { preferenceHistory: [{ id, feelings, bookIds, genres, dislikes,
 *   dislikedBookIds, readerType, changedFields, source, recordedAt }],
 *   pagination: { total, limit, offset, hasMore } }
 * Errors: 400 invalid query | 401 unauthenticated
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  preferenceHistoryController.list(req as AuthenticatedRequest, res),
);

/**
 * GET /api/v1/user/preference-history/:section
 *
 * One preference screen's History tab. `section` is `mood`, `genres` or
 * `avoid`. Lists the entries where that section changed, newest first, plus
 * the first entry (when it was set at signup), each shaped for that screen:
 *
 *   mood:   { id, recordedAt, prompt: string | null, moods: [{ key, label }] }
 *   genres: { id, recordedAt, genres: [{ key, label }] }
 *   avoid:  { id, recordedAt, dealBreakers: string[], categories: { [category]: string[] } }
 *
 * Query (optional): { limit? (1-100, default 20), offset? (default 0) }
 * Returns 200: { section, history: [...], pagination: { total, limit, offset, hasMore } }
 * Errors: 400 unknown section or invalid query | 401 unauthenticated
 */
router.get('/:section', requireAuth, (req: Request, res: Response) =>
  preferenceHistoryController.listSection(req as AuthenticatedRequest, res),
);

/**
 * GET /api/v1/user/preference-history/:section/:id
 *
 * One entry, shaped for the section's detail screen ("Your mood preferences
 * on August 10, 2026"). Same entry shape as the list above.
 *
 * Returns 200: { section, entry }
 * Errors: 400 unknown section or id | 401 unauthenticated | 404 not the caller's entry
 */
router.get('/:section/:id', requireAuth, (req: Request, res: Response) =>
  preferenceHistoryController.getSectionEntry(req as AuthenticatedRequest, res),
);

export default router;
