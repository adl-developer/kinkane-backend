import { describe, it, expect } from 'vitest';
import {
  INTERACTION_WEIGHTS,
  TRENDING_SCORED_TYPES,
  TRENDING_HALF_LIFE_DAYS,
  VIEW_DEDUPE_TTL,
  decayFactor,
  isRedisDeduped,
  viewDedupeKey,
  type InteractionType,
} from '../services/interactions.service';

// The weights decide what the public "Trending" shelf shows, so the properties
// that make the ranking sane are pinned here rather than left to reviewer memory.
describe('interaction weights', () => {
  it('orders signals by depth in the funnel', () => {
    const { view, like, want_to_read, reading, read } = INTERACTION_WEIGHTS;
    expect(view).toBeLessThan(like);
    expect(like).toBeLessThan(want_to_read);
    expect(want_to_read).toBeLessThan(reading);
    expect(reading).toBeLessThan(read);
  });

  it('keeps a view worth well under a deliberate action', () => {
    // If a view ever creeps close to a like, trending degenerates into a
    // pageview counter — the whole point of the weighting is lost.
    expect(INTERACTION_WEIGHTS.view * 4).toBeLessThanOrEqual(INTERACTION_WEIGHTS.like);
  });

  it('assigns a weight to every scored type', () => {
    for (const type of TRENDING_SCORED_TYPES) {
      expect(INTERACTION_WEIGHTS[type]).toBeGreaterThan(0);
    }
  });

  it('does not score types nothing writes yet', () => {
    expect(TRENDING_SCORED_TYPES).not.toContain('purchase' as InteractionType);
    expect(TRENDING_SCORED_TYPES).not.toContain('high_rating' as InteractionType);
  });

  it('leaves the onboarding signal at its historical weight', () => {
    // Changing this would retroactively reweight every pre-existing row.
    expect(INTERACTION_WEIGHTS.chosen_from_recommendation).toBe(1);
  });
});

// A book with broad interest must beat a book with deep interest from few people.
describe('trending ranking behaviour', () => {
  const score = (counts: Partial<Record<InteractionType, number>>): number =>
    Object.entries(counts).reduce(
      (total, [type, n]) => total + INTERACTION_WEIGHTS[type as InteractionType] * (n ?? 0),
      0,
    );

  it('ranks a buzzy book above an older well-read one', () => {
    expect(score({ want_to_read: 50 })).toBeGreaterThan(score({ read: 10 }));
  });

  it('does not let views alone outrank real engagement', () => {
    // 20 distinct viewers still lose to 3 people who shelved the book.
    expect(score({ view: 20 })).toBeLessThan(score({ want_to_read: 3 }));
  });

  it('rewards a full read-through over a single shelving', () => {
    // Progressing want_to_read → reading → read records all three.
    expect(score({ want_to_read: 1, reading: 1, read: 1 })).toBeGreaterThan(
      score({ want_to_read: 1 }),
    );
  });
});

describe('time decay', () => {
  it('is a no-op for a signal recorded just now', () => {
    expect(decayFactor(0)).toBe(1);
  });

  it('halves the contribution after exactly one half-life', () => {
    expect(decayFactor(TRENDING_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 10);
  });

  it('quarters it after two half-lives', () => {
    expect(decayFactor(TRENDING_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 10);
  });

  it('has nearly faded by the edge of the 30-day trending window', () => {
    expect(decayFactor(30)).toBeLessThan(0.06);
  });

  it('makes a fresh weak signal beat a stale strong one', () => {
    // A view today vs. a read from six weeks ago — trending should favour now.
    const freshView = INTERACTION_WEIGHTS.view * decayFactor(0);
    const staleRead = INTERACTION_WEIGHTS.read * decayFactor(42);
    expect(freshView).toBeGreaterThan(staleRead);
  });

  it('decreases monotonically with age', () => {
    for (let day = 1; day <= 30; day++) {
      expect(decayFactor(day)).toBeLessThan(decayFactor(day - 1));
    }
  });
});

describe('dedupe guards', () => {
  it('rate-limits views in Redis', () => {
    expect(isRedisDeduped('view')).toBe(true);
  });

  it('leaves every other type to the database unique index', () => {
    for (const type of TRENDING_SCORED_TYPES.filter((t) => t !== 'view')) {
      expect(isRedisDeduped(type)).toBe(false);
    }
  });

  it('scopes the view key to a single user and book', () => {
    expect(viewDedupeKey(1, 2)).not.toBe(viewDedupeKey(2, 1));
    expect(viewDedupeKey(1, 2)).toBe(viewDedupeKey(1, 2));
  });

  it('caps one user’s view contribution to roughly a single point', () => {
    // The guard is what stops a single user refreshing a page into the top spot.
    const windowDays = 30;
    const viewsPerWindow = Math.floor(windowDays / (VIEW_DEDUPE_TTL / 86400));
    const maxContribution = viewsPerWindow * INTERACTION_WEIGHTS.view;

    expect(maxContribution).toBeLessThan(INTERACTION_WEIGHTS.like);
  });
});
