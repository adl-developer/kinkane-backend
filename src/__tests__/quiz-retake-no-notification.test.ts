import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
// vi.mock is hoisted above this import, so the controller picks up the mocks.
import { recommendationsController } from '../controllers/recommendations.controller';

/**
 * Retaking the quiz must never send a new-book notification.
 *
 * It used to: every PATCH /recommendations/refresh fired one (email, push and
 * in-app) as soon as 24 hours had passed since the last, so a reader who had
 * just been shown a full list of picks got a "new book" on top of it — often
 * one from that very list. New-book notifications now come from the scheduled
 * job alone, on its own cadence.
 */

const { sendRecommendationEmail, maybeSendRecommendationAfterRefresh, enqueueEmail, enqueuePush, refresh } =
  vi.hoisted(() => ({
    sendRecommendationEmail: vi.fn(),
    // The entry point the retake used to call. Kept in the mock so that wiring it
    // back in fails here rather than throwing a TypeError the controller swallows.
    maybeSendRecommendationAfterRefresh: vi.fn().mockResolvedValue(undefined),
    enqueueEmail: vi.fn(),
    enqueuePush: vi.fn(),
    refresh: vi.fn(),
  }));

vi.mock('../services/recommendation-notifications.service', () => ({
  sendRecommendationEmail,
  maybeSendRecommendationAfterRefresh,
  pickUnsentRecommendation: vi.fn(),
}));
vi.mock('../lib/email-queue', () => ({ enqueueEmail, bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush }));
vi.mock('../services/recommendations.service', () => ({ recommendationsService: { refresh } }));
vi.mock('../services/my-reviews.service', () => ({ withMyReviews: async (_: number, items: unknown) => items }));

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const body = { feelings: ['a', 'b', 'c'], genres: ['x', 'y', 'z'], bookIds: [], dislikes: {} };

describe('PATCH /recommendations/refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['without recommendations', {}],
    ['with recommendations', { includeRecommendations: 'true' }],
  ])('sends no new-book notification %s', async (_, query) => {
    refresh.mockResolvedValue({ ...body, dislikedBookIds: [], recommendations: [{ bookId: 1, rank: 1, explanation: '' }] });
    const req = { body, query, user: { id: 7 } } as unknown as Request;
    const res = response();

    await recommendationsController.refresh(req, res);
    // Anything fire-and-forget would have been scheduled by now.
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status.mock.calls).toEqual([[200]]);
    expect(maybeSendRecommendationAfterRefresh).not.toHaveBeenCalled();
    expect(sendRecommendationEmail).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(enqueuePush).not.toHaveBeenCalled();
  });
});
