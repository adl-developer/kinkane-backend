import { Response } from 'express';
import { z } from 'zod';
import { userBooksService } from '../services/user-books.service';
import { withMyReviews } from '../services/my-reviews.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const listSchema = z.object({
  q: z.string().min(1).max(200).optional(),
  status: z.enum(['want_to_read', 'reading', 'read']).optional(),
  liked: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  owned: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  sort: z.enum(['title_asc', 'title_desc', 'date_asc', 'date_desc']).default('date_desc'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// Either a password (email/password accounts) or a Firebase ID token (social accounts).
// Exactly one must be provided.
const resetLibrarySchema = z
  .object({
    password: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
  })
  .refine((d) => (d.password !== undefined) !== (d.idToken !== undefined), {
    message: 'Provide either password or idToken, not both and not neither',
  });

const upsertSchema = z
  .object({
    // null clears the reading status, leaving Favourite and Owned as they are.
    status: z.enum(['want_to_read', 'reading', 'read']).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    noteIsPublic: z.boolean().optional(),
    liked: z.boolean().optional(),
    owned: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.status !== undefined ||
      data.note !== undefined ||
      data.noteIsPublic !== undefined ||
      data.liked !== undefined ||
      data.owned !== undefined,
    { message: 'At least one of status, note, noteIsPublic, liked, or owned must be provided' },
  );

/**
 * A handler for a body-less action on one shelf book: parse `:bookId`, run it,
 * answer `{ success: true }`. A service error with a statusCode (404 book not
 * found) keeps it; anything else is a 500.
 */
function bookAction(action: (userId: number, bookId: number) => Promise<void>) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const bookId = parseInt(req.params.bookId, 10);
    if (isNaN(bookId)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    try {
      await action(req.user.id, bookId);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  };
}

export const userBooksController = {
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const result = await userBooksService.list({
        userId: req.user.id,
        ...parsed.data,
      });
      res.status(200).json({
        books: await withMyReviews(req.user.id, result.books, (b) => b.bookId),
        total: result.total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async upsert(req: AuthenticatedRequest, res: Response): Promise<void> {
    const bookId = parseInt(req.params.bookId, 10);
    if (isNaN(bookId)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      await userBooksService.upsert(req.user.id, bookId, parsed.data);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async resetLibrary(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = resetLibrarySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const credential = parsed.data.idToken
      ? { idToken: parsed.data.idToken }
      : { password: parsed.data.password! };

    try {
      const { deleted } = await userBooksService.resetLibrary(req.user.id, credential);
      res.status(200).json({ deleted });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      res.status(status).json({ error: e.message });
    }
  },

  remove: bookAction((userId, bookId) => userBooksService.remove(userId, bookId)),
  like: bookAction((userId, bookId) => userBooksService.like(userId, bookId)),
  unlike: bookAction((userId, bookId) => userBooksService.unlike(userId, bookId)),
  own: bookAction((userId, bookId) => userBooksService.own(userId, bookId)),
  unown: bookAction((userId, bookId) => userBooksService.unown(userId, bookId)),
};
