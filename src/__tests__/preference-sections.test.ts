import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import type { UserPreferenceHistory } from '../db/schema';
import {
  avoidSection,
  genreSection,
  moodSection,
  sectionEntry,
  titleCase,
} from '../lib/preference-sections';
import { preferenceHistoryService } from '../services/preference-history.service';
import { preferenceHistoryController } from '../controllers/preference-history.controller';

vi.mock('../db', () => ({ db: {} }));

// The detail screens in the design: "Your mood preferences on August 10, 2026"
// shows a written prompt above three cards, genres show as labelled cards, and
// deal-breakers as one list of chips.

describe('moodSection', () => {
  it('splits the written prompt from the tapped cards', () => {
    const result = moodSection([
      'I want to feel like I am in a foggy coastal town living in a lighthouse.',
      'Comforted',
      'Challenged',
      'Escaped',
    ]);

    expect(result.prompt).toBe(
      'I want to feel like I am in a foggy coastal town living in a lighthouse.',
    );
    expect(result.moods).toEqual([
      { key: 'comforted', label: 'Comforted' },
      { key: 'challenged', label: 'Challenged' },
      { key: 'escaped', label: 'Escaped' },
    ]);
  });

  it('recognises cards whatever case the client sent them in', () => {
    expect(moodSection(['inspired', 'RELAXED', 'Thoughtful']).moods.map((m) => m.key)).toEqual([
      'inspired',
      'relaxed',
      'thoughtful',
    ]);
  });

  it('has no prompt when only cards were chosen', () => {
    expect(moodSection(['comforted', 'escaped']).prompt).toBeNull();
  });

  it('keeps a second free-text entry as a card rather than dropping it', () => {
    const result = moodSection(['a foggy town', 'comforted', 'something cosy']);

    expect(result.prompt).toBe('a foggy town');
    expect(result.moods).toContainEqual({ key: null, label: 'something cosy' });
  });
});

describe('genreSection', () => {
  it('labels each genre the way the card shows it', () => {
    expect(genreSection(['literary fiction', 'sci-fi', 'self-help', 'society & education'])).toEqual({
      genres: [
        { key: 'literary fiction', label: 'Literary Fiction' },
        { key: 'sci-fi', label: 'Sci-Fi' },
        { key: 'self-help', label: 'Self-Help' },
        { key: 'society & education', label: 'Society & Education' },
      ],
    });
  });

  it('title-cases after hyphens', () => {
    expect(titleCase('non-fiction')).toBe('Non-Fiction');
  });
});

describe('avoidSection', () => {
  const dislikes = {
    emotionalTone: ['too dark or heavy', 'sad or tragic ending'],
    contentSensitivity: ['Too dark or heavy'],
    commitmentLevel: ['long book (500+ pages)'],
  };

  it('flattens the categories into one chip list', () => {
    expect(avoidSection(dislikes).dealBreakers).toEqual([
      'Too dark or heavy',
      'Sad or tragic ending',
      'Long book (500+ pages)',
    ]);
  });

  it('shows a label chosen under two categories once', () => {
    const chips = avoidSection(dislikes).dealBreakers;
    expect(chips.filter((c) => c.toLowerCase() === 'too dark or heavy')).toHaveLength(1);
  });

  it('keeps the grouping alongside', () => {
    expect(avoidSection(dislikes).categories).toBe(dislikes);
  });
});

const ROW = {
  id: 88,
  userId: 7,
  feelings: ['a foggy coastal town', 'comforted'],
  bookIds: [1],
  genres: ['poetry'],
  dislikes: { emotionalTone: ['too dark or heavy'] },
  dislikedBookIds: [],
  readerType: 'The Seeker',
  changedFields: ['feelings'],
  source: 'user_edit',
  recordedAt: new Date('2026-08-10T14:00:00Z'),
} as unknown as UserPreferenceHistory;

describe('sectionEntry', () => {
  it('returns only the section the screen shows', () => {
    const entry = sectionEntry('genres', ROW);

    expect(entry).toEqual({
      id: 88,
      recordedAt: ROW.recordedAt,
      genres: [{ key: 'poetry', label: 'Poetry' }],
    });
  });
});

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
  };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}

function request(params: Record<string, string>, query: Record<string, string> = {}) {
  return { params, query, user: { id: 7 } } as never;
}

describe('GET /user/preference-history/:section', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('filters to the field behind the section', async () => {
    const list = vi
      .spyOn(preferenceHistoryService, 'list')
      .mockResolvedValue({ items: [ROW], total: 1 });
    const res = fakeRes();

    await preferenceHistoryController.listSection(request({ section: 'mood' }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(7, { limit: 20, offset: 0, field: 'feelings' });
    expect(res.body).toMatchObject({
      section: 'mood',
      history: [{ id: 88, prompt: 'a foggy coastal town', moods: [{ key: 'comforted' }] }],
      pagination: { total: 1, hasMore: false },
    });
  });

  it('maps avoid to the deal-breakers', async () => {
    const list = vi
      .spyOn(preferenceHistoryService, 'list')
      .mockResolvedValue({ items: [], total: 0 });

    await preferenceHistoryController.listSection(
      request({ section: 'avoid' }),
      fakeRes() as unknown as Response,
    );

    expect(list.mock.calls[0][1]).toMatchObject({ field: 'dislikes' });
  });

  it('rejects an unknown section', async () => {
    const res = fakeRes();

    await preferenceHistoryController.listSection(request({ section: 'feelings' }), res as unknown as Response);

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /user/preference-history/:section/:id', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the entry shaped for the section', async () => {
    const get = vi.spyOn(preferenceHistoryService, 'get').mockResolvedValue(ROW);
    const res = fakeRes();

    await preferenceHistoryController.getSectionEntry(
      request({ section: 'avoid', id: '88' }),
      res as unknown as Response,
    );

    expect(get).toHaveBeenCalledWith(7, 88);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ section: 'avoid', entry: { dealBreakers: ['Too dark or heavy'] } });
  });

  it('is a 404 when the entry is not the caller’s', async () => {
    vi.spyOn(preferenceHistoryService, 'get').mockResolvedValue(null);
    const res = fakeRes();

    await preferenceHistoryController.getSectionEntry(
      request({ section: 'mood', id: '88' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(404);
  });
});
