import { sgMail, FROM } from '../../lib/sendgrid';

export interface RecommendedBook {
  title: string;
  author: string;
  reason: string;
  url: string;
}

export async function sendNewRecommendationEmail(
  to: string,
  name: string,
  book: RecommendedBook,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'We found a book for you',
    html: `
      <p>Hi ${name},</p>
      <p>Based on your reading preferences, we think you might enjoy:</p>
      <p><strong>${book.title}</strong><br/>by ${book.author}</p>
      <p>${book.reason}</p>
      <p>Add it to your bookshelf, explore similar titles, or start reading today.</p>
      <p><a href="${book.url}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View Recommendation</a></p>
      <p>Until your next great read,<br/>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nBased on your reading preferences, we think you might enjoy:\n\n${book.title}\nby ${book.author}\n\n${book.reason}\n\nAdd it to your bookshelf, explore similar titles, or start reading today.\n${book.url}\n\nUntil your next great read,\nThe Kinkané Team`,
  });
}
