import { Request, Response } from 'express';
import { z } from 'zod';
import { recommendationsService } from '../services/recommendations.service';
import { logger } from '../lib/logger';

// ── Validation schemas ────────────────────────────────────────────────────────

// Accept any of the preset feeling labels OR a freeform "other" sentence (≤ 200 chars).
// The freeform text goes straight into the preference embedding — no special handling needed.
const feelingSchema = z.string().min(1).max(200);

const GENRE_VALUES = [
  'literary fiction',
  'poetry',
  'self-help',
  'mystery',
  'romance',
  'business',
  'horror',
  'sci-fi',
  'historical fiction',
  'biography',
  'fantasy',
  'non-fiction',
  'society & education',
  'sport',
  'crime',
  'young adult',
  'classics',
  'graphic novel',
  'politics',
  'health & lifestyle',
  'travel',
] as const;

const recommendationsSchema = z.object({
  displayName: z.string().min(1, 'Name is required').max(100),

  feelings: z
    .array(feelingSchema)
    .length(3, 'Exactly 3 feelings are required'),

  bookIds: z
    .array(z.number().int().positive())
    .max(10, 'A maximum of 10 book IDs are allowed')
    .default([]),

  genres: z
    .array(z.enum(GENRE_VALUES))
    .length(3, 'Exactly 3 genres are required'),

  dislikes: z
    .object({
      emotionalTone: z
        .array(z.enum(['too dark or heavy', 'sad or tragic ending', 'emotionally intense']))
        .optional(),
      pacingStructure: z
        .array(z.enum(['slow paced', 'complex or layered plot', 'multiple POVs']))
        .optional(),
      writingStyle: z
        .array(z.enum(['academic or dense', 'experimental writing style']))
        .optional(),
      genreFocus: z
        .array(z.enum(['romance-heavy', 'fantasy-heavy', 'faith-based themes']))
        .optional(),
      commitmentLevel: z
        .array(z.enum(['long book (500+ pages)', 'series commitment']))
        .optional(),
    })
    .default({}),
});

// ── Controller ────────────────────────────────────────────────────────────────

export const recommendationsController = {
  async getRecommendations(req: Request, res: Response): Promise<void> {
    const parsed = recommendationsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { recommendations, guestSessionId, expiresAt } =
        await recommendationsService.getRecommendations(parsed.data);
      res.status(200).json({ recommendations, guestSessionId, expiresAt });
    } catch (err: unknown) {
      logger.error('Unexpected error generating recommendations', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
