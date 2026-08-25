import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export async function sendRateReviewReminderEmail(
  to: string,
  name: string,
  book: { title: string; author: string; url: string },
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(book.title);
  const safeAuthor = escapeHtml(book.author);
  const title = 'Share your thoughts';

  const body = [
    greeting(safeName),
    p(`Looks like you finished <strong>${safeTitle}</strong> by ${safeAuthor}. Your take matters — readers like you are what makes the Kinkané community worth being part of.`),
    p('It only takes a minute to rate and share what you thought.'),
    ctaButton('Leave a Review', book.url),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: `How did you find "${book.title}"?`,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\nLooks like you finished "${book.title}" by ${book.author}. Your take matters — readers like you are what makes the Kinkané community worth being part of.\n\nIt only takes a minute to rate and share what you thought.\n\n${book.url}\n\nThe Kinkané Team`,
  });
}
