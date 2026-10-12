import { describe, it, expect } from 'vitest';
import { buildQuizGenreCondition } from '../services/recommendations.service';

// The genre fallback narrows to the reader's quiz genres only when it knows
// what they mean. An unknown chip must not narrow it to nothing.
describe('quiz genre condition', () => {
  it('maps known quiz genres, case-insensitively', () => {
    expect(buildQuizGenreCondition(['Crime', 'romance'])).toBeDefined();
  });

  it('does not narrow when only some of the genres map', () => {
    // Narrowing on the mapped half would quietly drop the rest of the answer:
    // romance + non-fiction would become a romance-only fallback.
    expect(buildQuizGenreCondition(['romance', 'non-fiction'])).toBeUndefined();
    expect(buildQuizGenreCondition(['crime', 'a chip added next month'])).toBeUndefined();
    expect(buildQuizGenreCondition(['crime', 'poetry'])).toBeDefined();
  });

  it('does not narrow on genres it has no mapping for', () => {
    expect(buildQuizGenreCondition(['non-fiction', 'something new'])).toBeUndefined();
    expect(buildQuizGenreCondition([])).toBeUndefined();
  });
});
