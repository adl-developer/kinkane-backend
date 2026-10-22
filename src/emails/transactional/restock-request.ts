import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p, bookCard, ctaButton } from '../lib/layout';
import { config } from '../../config';

export interface RestockEmailBook {
  title: string;
  author: string | null;
  /** "Paperback", "Hardcover", …, or null when the format is unknown. */
  format: string | null;
  coverUrl: string | null;
  /** The book's page in the web shop. */
  url: string;
}

/** "Wandering Stars (Paperback)", or just the title when the format is unknown. */
function titleWithFormat(book: RestockEmailBook): string {
  return book.format ? `${book.title} (${book.format})` : book.title;
}

/**
 * Who asked, as the admin email's opening words: "Amara Diallo
 * (amara@example.com)", or whichever of the two they gave, or "A customer".
 * Exported for the tests.
 */
export function requesterLabel(name: string | null, email: string | null): string {
  if (name && email) return `${name} (${email})`;
  return name ?? email ?? 'A customer';
}

/**
 * The staff notification for one restock request, to RESTOCK_INBOX.
 *
 * Sent **from** EMAIL_CONTACT_FROM (contactus@), not the no-reply sender the
 * customer emails use, and with no Reply-To: the client chose that replies stay
 * with the contact address rather than going to the customer.
 *
 * Wording is the client's, including "contact your publisher".
 */
export async function sendRestockRequestAdminEmail(payload: {
  reference: string;
  name: string | null;
  email: string | null;
  book: RestockEmailBook;
}): Promise<void> {
  const { book } = payload;
  const who = requesterLabel(payload.name, payload.email);
  const subject = `Restock request: ${titleWithFormat(book)}`;
  const author = book.author ?? 'Author unknown';

  const body = [
    p(`${escapeHtml(who)} has requested a restocking of this book:`),
    bookCard(escapeHtml(titleWithFormat(book)), escapeHtml(author), book.coverUrl, book.url),
    p(`<a href="${book.url}" style="color:#262626;">View the book on kinkane.app</a>`),
    p('Please contact your publisher to request restocking of the book.'),
    p(`Reference: ${escapeHtml(payload.reference)}`, true),
  ].join('\n');

  await sendEmail({
    to: config.email.restockInbox,
    from: `${config.email.fromName} <${config.email.contactFrom}>`,
    subject,
    html: emailLayout(subject, body),
    text: [
      `${who} has requested a restocking of this book:`,
      '',
      titleWithFormat(book),
      `by ${author}`,
      book.url,
      '',
      'Please contact your publisher to request restocking of the book.',
      '',
      `Reference: ${payload.reference}`,
    ].join('\n'),
  });
}

/**
 * The customer's confirmation, from the usual no-reply sender.
 *
 * Promises nothing it cannot keep: nobody emails the customer automatically
 * when the book comes back. The admin contacts them by hand if they can get it.
 */
export async function sendRestockRequestCustomerEmail(
  to: string,
  name: string | null,
  book: RestockEmailBook,
): Promise<void> {
  const subject = 'We’ve passed on your restock request';
  const author = book.author ?? 'Author unknown';
  const message =
    'We’ve told the Kinkané team you’re after this book. They’ll be in touch if they can get it back in stock.';

  const body = [
    greeting(name ? escapeHtml(name) : 'there'),
    bookCard(escapeHtml(titleWithFormat(book)), escapeHtml(author), book.coverUrl, book.url),
    p(message),
    ctaButton('View the book', book.url),
    signOff('Happy reading,'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(subject, body),
    text: `Hi ${name ?? 'there'},\n\n${titleWithFormat(book)}\nby ${author}\n\n${message}\n\n${book.url}\n\nHappy reading,\nThe Kinkané Team`,
  });
}
