import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { preferenceHistoryService } from '../services/preference-history.service';
import type { UserPreferenceHistory } from '../db/schema';
import { logger } from '../lib/logger';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function formatEntry(row: UserPreferenceHistory) {
  return {
    id: row.id,
    feelings: row.feelings,
    bookIds: row.bookIds,
    genres: row.genres,
    dislikes: row.dislikes,
    readerType: row.readerType ?? null,
    changedFields: row.changedFields,
    source: row.source,
    recordedAt: row.recordedAt,
  };
}

export const preferenceHistoryController = {
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { limit, offset } = parsed.data;
      // Scoped to req.user.id — a user can only ever read their own timeline.
      const { items, total } = await preferenceHistoryService.list(req.user.id, { limit, offset });

      res.status(200).json({
        preferenceHistory: items.map(formatEntry),
        pagination: { total, limit, offset, hasMore: offset + items.length < total },
      });
    } catch (err: unknown) {
      const e = err as Error;
      logger.error('Unexpected error fetching preference history', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
