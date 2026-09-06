import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p, bookCard } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export interface RecommendedBook {
  title: string;
  author: string;
  reason: string;
  url: string;
  /** Jacket image, or null when the catalogue has no cover for this title. */
  coverUrl?: string | null;
}

export async function sendNewRecommendationEmail(
  to: string,
  name: string,
  book: RecommendedBook,
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(book.title);
  const safeAuthor = escapeHtml(book.author);
  const safeReason = escapeHtml(book.reason);
  const title = 'We found a book for you';

  const body = [
    greeting(safeName),
    p('Based on your reading preferences, we think you might enjoy:'),
    bookCard(safeTitle, safeAuthor, book.coverUrl ?? null, book.url),
    p(safeReason),
    p('Add it to your bookshelf, explore similar titles, or start reading today.'),
    ctaButton('View Recommendation', book.url),
    signOff('Until your next great read,'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\nBased on your reading preferences, we think you might enjoy:\n\n${book.title}\nby ${book.author}\n\n${book.reason}\n\nAdd it to your bookshelf, explore similar titles, or start reading today.\n${book.url}\n\nUntil your next great read,\nThe Kinkané Team`,
  });
}
