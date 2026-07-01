import { sgMail, FROM } from '../../lib/sendgrid';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export async function sendRateReviewReminderEmail(
  to: string,
  name: string,
  book: { title: string; author: string; url: string },
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(book.title);
  const safeAuthor = escapeHtml(book.author);

  await sgMail.send({
    to,
    from: FROM,
    subject: `How did you find "${book.title}"?`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Looks like you finished <strong>${safeTitle}</strong> by ${safeAuthor}. Your take matters — readers like you are what makes the Kinkané community worth being part of.</p>
      <p>It only takes a minute to rate and share what you thought.</p>
      <p><a href="${book.url}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Leave a Review</a></p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nLooks like you finished "${book.title}" by ${book.author}. Your take matters — readers like you are what makes the Kinkané community worth being part of.\n\nIt only takes a minute to rate and share what you thought.\n\n${book.url}\n\nThe Kinkané Team`,
  });
}
