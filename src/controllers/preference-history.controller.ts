import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { preferenceHistoryService } from '../services/preference-history.service';
import type { PreferenceHistoryField, UserPreferenceHistory } from '../db/schema';
import { logger } from '../lib/logger';
import {
  PREFERENCE_SECTIONS,
  SECTION_FIELD,
  sectionEntry,
} from '../lib/preference-sections';

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

export const sectionParamsSchema = z.object({
  section: z.enum(PREFERENCE_SECTIONS),
});

export const sectionEntryParamsSchema = sectionParamsSchema.extend({
  id: z.coerce.number().int().positive(),
});

const pageSchema = historyQuerySchema.omit({ field: true });

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

  /**
   * GET /user/preference-history/:section
   * One section's History tab: the dates it changed, each with that section as
   * it stood then.
   */
  async listSection(req: AuthenticatedRequest, res: Response): Promise<void> {
    const params = sectionParamsSchema.safeParse(req.params);
    const query = pageSchema.safeParse(req.query);
    if (!params.success || !query.success) {
      res.status(400).json({
        error: {
          ...(params.success ? {} : params.error.flatten().fieldErrors),
          ...(query.success ? {} : query.error.flatten().fieldErrors),
        },
      });
      return;
    }

    try {
      const { section } = params.data;
      const { limit, offset } = query.data;
      const { items, total } = await preferenceHistoryService.list(req.user.id, {
        limit,
        offset,
        field: SECTION_FIELD[section],
      });

      res.status(200).json({
        section,
        history: items.map((row) => sectionEntry(section, row)),
        pagination: { total, limit, offset, hasMore: offset + items.length < total },
      });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching preference section history', {
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  /**
   * GET /user/preference-history/:section/:id
   * The detail screen: "Your genre preferences on August 10, 2026".
   */
  async getSectionEntry(req: AuthenticatedRequest, res: Response): Promise<void> {
    const params = sectionEntryParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.flatten().fieldErrors });
      return;
    }

    try {
      const { section, id } = params.data;
      const row = await preferenceHistoryService.get(req.user.id, id);
      if (!row) {
        res.status(404).json({ error: 'History entry not found' });
        return;
      }
      res.status(200).json({ section, entry: sectionEntry(section, row) });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching preference history entry', {
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
