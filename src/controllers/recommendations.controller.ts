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

// Open by design — both the category keys and the labels inside them belong to
// the onboarding UI. Validating them against a fixed enum here meant every copy
// tweak or new category (e.g. "Content Sensitivity") was a backend release, and
// a mismatch failed the whole request rather than degrading gracefully. The only
// constraint kept is a length cap, since every label ends up in the embedded
// preference text. Category keys map to string arrays; nothing else is assumed.
const dislikesSchema = z.record(
  z.string().min(1).max(100),
  z.array(z.string().min(1).max(200)),
);

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

// Refresh uses the same shape minus displayName. It used to also accept
// dislikedBookIds; that moved to POST /selections, which is now the single
// write path for a logged-in user's rejections. Strict so a client still
// sending the old field gets a 400 telling it so, rather than having its
// swipes silently dropped.
const refreshSchema = recommendationsSchema.omit({ displayName: true }).strict();

// The logged-in twin of the guest selections body. Same bounds as
// guest.controller's version deliberately: it's the same screen, and a retake
// should not have different rules than a first run.
const selectionsSchema = z.object({
  chosenBookIds: z
    .array(z.number().int().positive())
    .min(1, 'At least 1 book must be chosen')
    .max(5, 'A maximum of 5 books can be chosen'),

  // Books swiped away on the same screen. Optional — a user can pick without
  // rejecting anything. Unbounded above by design: the recommendation list runs
  // to 100 books and a thorough swiper can reject most of them.
  dislikedBookIds: z.array(z.number().int().positive()).default([]),
});

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
          preferences: {
            feelings: result.feelings,
            genres: result.genres,
            dislikes: result.dislikes,
            bookIds: result.bookIds,
            dislikedBookIds: result.dislikedBookIds,
          },
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

  /**
   * POST /api/v1/recommendations/selections
   * Saves the books a signed-in user picked after retaking the quiz.
   */
  async saveSelections(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const result = await recommendationsService.saveSelections(
        req.user.id,
        parsed.data.chosenBookIds,
        parsed.data.dislikedBookIds,
      );
      res.status(200).json({ readerType: result.readerType, books: result.books });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error saving quiz selections', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },
};
