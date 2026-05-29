import { Response } from 'express';
import { z } from 'zod';
import { userBooksService } from '../services/user-books.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const listSchema = z.object({
  q: z.string().min(1).max(200).optional(),
  status: z.enum(['want_to_read', 'reading', 'read']).optional(),
  sort: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const upsertSchema = z
  .object({
    status: z.enum(['want_to_read', 'reading', 'read']).optional(),
    note: z.string().max(1000).nullable().optional(),
    noteIsPublic: z.boolean().optional(),
  })
  .refine(
    (data) => data.status !== undefined || data.note !== undefined || data.noteIsPublic !== undefined,
    { message: 'At least one of status, note, or noteIsPublic must be provided' },
  );

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
        books: result.books,
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

  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    const bookId = parseInt(req.params.bookId, 10);
    if (isNaN(bookId)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    try {
      await userBooksService.remove(req.user.id, bookId);
      res.status(204).send();
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },
};
