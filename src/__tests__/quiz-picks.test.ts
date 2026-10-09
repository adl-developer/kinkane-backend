import { describe, it, expect } from 'vitest';
import { quizPickShelfRows, type QuizPickSource } from '../lib/quiz-picks';

/**
 * Both quiz paths — the first quiz, saved at signup, and a retake — insert
 * these rows, so this pins what a quiz pick is on the shelf for both.
 */
describe('quizPickShelfRows', () => {
  const sources: QuizPickSource[] = ['chosen_from_onboarding', 'chosen_from_quiz'];

  it.each(sources)('shelves %s picks as want to read, not liked', (source) => {
    const rows = quizPickShelfRows(7, [11, 12], source);

    expect(rows).toEqual([
      { userId: 7, bookId: 11, status: 'want_to_read', source, liked: false },
      { userId: 7, bookId: 12, status: 'want_to_read', source, liked: false },
    ]);
  });

  // A like carries a timestamp; a pick that isn't liked must not have one, or
  // it would sort into "recently liked" lists.
  it('never sets likedAt', () => {
    for (const row of quizPickShelfRows(7, [11], 'chosen_from_onboarding')) {
      expect(row.likedAt ?? null).toBeNull();
    }
  });

  it('returns no rows for no picks', () => {
    expect(quizPickShelfRows(7, [], 'chosen_from_quiz')).toEqual([]);
  });
});
