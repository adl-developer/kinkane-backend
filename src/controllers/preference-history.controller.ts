import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { preferenceHistoryService } from '../services/preference-history.service';
import type { PreferenceHistoryField, UserPreferenceHistory } from '../db/schema';
import { logger } from '../lib/logger';

// Mirrors PreferenceHistoryField. The app's per-section history screens use
// feelings (mood), genres, and dislikes (what to avoid); the rest are accepted
// because the filter works the same for any field `changedFields` can name.
const HISTORY_FIELDS = [
  'feelings',
  'bookIds',
  'genres',
  'dislikes',
  'dislikedBookIds',
  'readerType',
] as const satisfies readonly PreferenceHistoryField[];

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  field: z.enum(HISTORY_FIELDS).optional(),
});

function formatEntry(row: UserPreferenceHistory) {
  return {
    id: row.id,
    feelings: row.feelings,
    bookIds: row.bookIds,
    genres: row.genres,
    dislikes: row.dislikes,
    dislikedBookIds: row.dislikedBookIds,
    readerType: row.readerType ?? null,
    changedFields: row.changedFields,
    source: row.source,
    recordedAt: row.recordedAt,
  };
}

export const preferenceHistoryController = {
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { limit, offset, field } = parsed.data;
      // Scoped to req.user.id — a user can only ever read their own timeline.
      const { items, total } = await preferenceHistoryService.list(req.user.id, {
        limit,
        offset,
        field,
      });

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
