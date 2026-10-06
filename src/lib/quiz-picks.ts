import type { userBooks } from '../db/schema';

/**
 * Where a quiz pick was made: the first quiz, saved when the guest signs up, or
 * a retake by a signed-in reader (POST /recommendations/selections).
 */
export type QuizPickSource = 'chosen_from_onboarding' | 'chosen_from_quiz';

/**
 * The shelf rows for books a reader picked in the quiz — the one definition
 * both quiz paths insert, so the first quiz and a retake can't drift apart.
 *
 * Picks go on the shelf as Want to Read and are not liked: a quiz pick is a
 * book to read next, and liking is the reader's own act (the heart), not
 * something a quiz answer should do for them.
 */
export function quizPickShelfRows(
  userId: number,
  bookIds: number[],
  source: QuizPickSource,
): (typeof userBooks.$inferInsert)[] {
  return bookIds.map((bookId) => ({
    userId,
    bookId,
    status: 'want_to_read',
    source,
    liked: false,
  }));
}
