import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlus } from '../middleware/require-plus.middleware';
import { userBooksController } from '../controllers/user-books.controller';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

// The bookshelf is a Plus feature, but only to *build*. Reading it stays free
// so a lapsed member never loses sight of what they saved, and removing an
// entry stays free so they can always clean up after themselves — the
// "retain, read-only" downgrade.

/**
 * The value of each PUT field that takes something off a shelf entry rather
 * than adding to it.
 */
const CLEARING_VALUES: Record<string, (v: unknown) => boolean> = {
  status: (v) => v === null,
  liked: (v) => v === false,
  owned: (v) => v === false,
  noteIsPublic: (v) => v === false,
  note: (v) => v === null || (typeof v === 'string' && v.trim() === ''),
};

/**
 * requirePlus for a PUT that adds anything; skipped for one that only clears
 * fields (`{ status: null }`, `{ owned: false }`, …). Without this, a lapsed
 * member could only drop a reading status by deleting the whole entry — and
 * its Favourite, Owned and note with it.
 *
 * Any unknown key, or an empty body, goes to requirePlus; the controller's
 * validation still runs on everything that gets through.
 */
function requirePlusUnlessClearing(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  const entries = body && typeof body === 'object' ? Object.entries(body) : [];
  const onlyClears =
    entries.length > 0 &&
    // hasOwn, so a key like "constructor" can't reach Object.prototype.
    entries.every(([key, value]) => Object.hasOwn(CLEARING_VALUES, key) && CLEARING_VALUES[key](value));
  if (onlyClears) {
    next();
    return;
  }
  requirePlus(req, res, next);
}

/**
 * GET /user-books?q=harry&sort=title_asc&limit=20&offset=0
 * Returns the authenticated user's reading list.
 * Sections: status=want_to_read|reading|read, liked=true (Favourites),
 * owned=true (Owned). A book can be in one status section plus Favourites
 * and Owned at once.
 * Searchable by title (q). Sortable: title_asc | title_desc | date_asc | date_desc.
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  userBooksController.list(req as AuthenticatedRequest, res),
);

/**
 * PUT /user-books/:bookId
 * Add a book to the reading list or update an existing entry.
 * Body (all fields optional, but at least one required):
 *   { status?: 'want_to_read' | 'reading' | 'read' | null, note?: string | null,
 *     noteIsPublic?: boolean, liked?: boolean, owned?: boolean }
 * - First call: inserts with sensible defaults for omitted fields.
 * - Subsequent calls: updates only the supplied fields.
 * - status: null clears the reading status. If that leaves the entry with no
 *   status, not liked, not owned and no note, the entry is removed.
 * - Needs Plus, unless the body only clears fields (see requirePlusUnlessClearing).
 */
router.put('/:bookId', requireAuth, requirePlusUnlessClearing, (req: Request, res: Response) =>
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
router.post('/:bookId/like', requireAuth, requirePlus, (req: Request, res: Response) =>
  userBooksController.like(req as AuthenticatedRequest, res),
);

/**
 * DELETE /user-books/:bookId/like
 * Unlike a book. Clears the liked flag; the shelf entry is removed only if
 * nothing else is left on it (no status, not owned, no note).
 * Returns 200: { success: true }
 */
router.delete('/:bookId/like', requireAuth, (req: Request, res: Response) =>
  userBooksController.unlike(req as AuthenticatedRequest, res),
);

/**
 * POST /user-books/:bookId/own
 * Mark a book as Owned. Creates a shelf entry if one doesn't exist yet (with
 * no reading status — just the owned flag). Idempotent.
 * Returns 200: { success: true }
 * Errors: 404 book not found
 */
router.post('/:bookId/own', requireAuth, requirePlus, (req: Request, res: Response) =>
  userBooksController.own(req as AuthenticatedRequest, res),
);

/**
 * DELETE /user-books/:bookId/own
 * Un-mark a book as Owned. Same removal rule as unlike. Free, like every
 * removal, so a lapsed member can still tidy their shelf.
 * Returns 200: { success: true }
 */
router.delete('/:bookId/own', requireAuth, (req: Request, res: Response) =>
  userBooksController.unown(req as AuthenticatedRequest, res),
);

export default router;
