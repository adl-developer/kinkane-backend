import { sgMail, FROM } from '../../lib/sendgrid';

export interface RecommendedBook {
  title: string;
  author: string;
  coverUrl?: string;
}

/**
 * Notifies a user that fresh recommendations are waiting for them.
 * @param books - A short list of recommended titles to preview (typically 3).
 */
export async function sendNewRecommendationEmail(
  to: string,
  name: string,
  books: RecommendedBook[],
): Promise<void> {
  const bookList = books
    .map(
      (b) => `<li><strong>${b.title}</strong> by ${b.author}</li>`,
    )
    .join('');

  const bookListText = books.map((b) => `- ${b.title} by ${b.author}`).join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: `${name}, your new book picks are ready 📖`,
    html: `
      <p>Hi ${name},</p>
      <p>We've put together some new picks based on your reading taste:</p>
      <ul>${bookList}</ul>
      <p><a href="https://kinkane.com/recommendations" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">See All Recommendations</a></p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nYour new picks:\n${bookListText}\n\nSee all: https://kinkane.com/recommendations\n\nThe Kinkane Team`,
  });
}
