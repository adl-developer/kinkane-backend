import { Request, Response } from 'express';
import { z } from 'zod';
import { recommendationsService } from '../services/recommendations.service';
import { maybeSendRecommendationAfterRefresh } from '../services/recommendation-notifications.service';
import { logger } from '../lib/logger';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

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

const dislikesSchema = z
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
  });

const recommendationsSchema = z.object({
  displayName: z.string().min(1, 'Name is required').max(100),

  feelings: z
    .array(feelingSchema)
    .min(1, 'At least 1 feeling is required'),

  bookIds: z
    .array(z.number().int().positive())
    .max(10, 'A maximum of 10 book IDs are allowed')
    .default([]),

  genres: z
    .array(z.enum(GENRE_VALUES))
    .min(1, 'At least 1 genre is required'),

  dislikes: dislikesSchema.default({}),
});

// Refresh uses the same shape minus displayName
const refreshSchema = recommendationsSchema.omit({ displayName: true });

// Opt-in flag on /refresh — by default no recommendations are computed or
// returned (just a preference update), since that's an expensive Gemini-backed
// pipeline most preference edits don't need. Pass ?includeRecommendations=true
// to run the full pipeline and get a recommendation list back.
// NOTE: z.coerce.boolean() would treat the literal string "false" as truthy
// (any non-empty string coerces to true), so the accepted values are explicit.
const refreshQuerySchema = z.object({
  includeRecommendations: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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

  async getPreferences(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const preferences = await recommendationsService.getPreferences(req.user.id);
      res.status(200).json({ preferences });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error fetching user preferences', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const parsedBody = refreshSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.flatten().fieldErrors });
      return;
    }

    const parsedQuery = refreshQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.flatten().fieldErrors });
      return;
    }

    const { user } = req as AuthenticatedRequest;

    try {
      const result = await recommendationsService.refresh(
        user.id,
        parsedBody.data,
        parsedQuery.data.includeRecommendations,
      );

      if (parsedQuery.data.includeRecommendations) {
        res.status(200).json({ recommendations: result.recommendations });
      } else {
        res.status(200).json({
          preferences: { feelings: result.feelings, genres: result.genres, dislikes: result.dislikes, bookIds: result.bookIds },
        });
      }

      maybeSendRecommendationAfterRefresh(user.id).catch((err) => {
        logger.error('Failed to dispatch recommendation email after refresh', {
          userId: user.id,
          error: (err as Error).message,
        });
      });
    } catch (err: unknown) {
      logger.error('Unexpected error refreshing recommendations', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
