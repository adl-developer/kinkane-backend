import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { userBooksController } from '../controllers/user-books.controller';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /user-books?q=harry&sort=asc&limit=20&offset=0
 * Returns the authenticated user's reading list.
 * Searchable by title (q). Sortable by title: sort=asc (A–Z) | sort=desc (Z–A).
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  userBooksController.list(req as AuthenticatedRequest, res),
);

/**
 * PUT /user-books/:bookId
 * Add a book to the reading list or update an existing entry.
 * Body (all fields optional, but at least one required):
 *   { status?: 'want_to_read' | 'reading' | 'read', note?: string | null, noteIsPublic?: boolean }
 * - First call: inserts with sensible defaults for omitted fields.
 * - Subsequent calls: updates only the supplied fields.
 */
router.put('/:bookId', requireAuth, (req: Request, res: Response) =>
  userBooksController.upsert(req as AuthenticatedRequest, res),
);

/**
 * POST /user-books/reset
 * Clears the user's entire reading list after verifying their password.
 * Body: { password }
 * Returns 200: { deleted: number } — the count of removed entries.
 * Errors: 400 missing password | 400 social account | 401 wrong password
 */
router.post('/reset', requireAuth, (req: Request, res: Response) =>
  userBooksController.resetLibrary(req as AuthenticatedRequest, res),
);

/**
 * DELETE /user-books/:bookId
 * Remove a book from the user's reading list entirely.
 * Returns 200: { success: true }
 */
router.delete('/:bookId', requireAuth, (req: Request, res: Response) =>
  userBooksController.remove(req as AuthenticatedRequest, res),
);

/**
 * POST /user-books/:bookId/like
 * Like a book. Creates a shelf entry if one doesn't exist yet (with no reading
 * status — just the liked flag). Idempotent.
 * Returns 200: { success: true }
 * Errors: 404 book not found
 */
router.post('/:bookId/like', requireAuth, (req: Request, res: Response) =>
  userBooksController.like(req as AuthenticatedRequest, res),
);

/**
 * DELETE /user-books/:bookId/like
 * Unlike a book. If the book has no reading status the shelf entry is removed
 * entirely; otherwise only the liked flag is cleared.
 * Returns 200: { success: true }
 */
router.delete('/:bookId/like', requireAuth, (req: Request, res: Response) =>
  userBooksController.unlike(req as AuthenticatedRequest, res),
);

export default router;
