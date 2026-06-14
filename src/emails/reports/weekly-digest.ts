import { sgMail, FROM } from '../../lib/sendgrid';

export interface WeeklyDigestPayload {
  name: string;
  booksAdded: number;
  newRecommendations: number;
  trendingBook: string;
  featuredBook: string;
  featuredAuthor: string;
}

export async function sendWeeklyDigestEmail(to: string, payload: WeeklyDigestPayload): Promise<void> {
  const { name, booksAdded, newRecommendations, trendingBook, featuredBook, featuredAuthor } = payload;

  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your week in books 📚',
    html: `
      <p>Hi ${name},</p>
      <p>Here's your reading summary for the week:</p>
      <ul>
        <li>📖 Books added to your shelf: <strong>${booksAdded}</strong></li>
        <li>📖 New recommendations waiting: <strong>${newRecommendations}</strong></li>
        <li>📖 Trending among readers: <strong>${trendingBook}</strong></li>
        <li>📖 Recommended for you this week: <strong>${featuredBook}</strong> by ${featuredAuthor}</li>
      </ul>
      <p>Keep exploring, saving, and discovering stories you'll love.</p>
      <p><a href="https://kinkane.com" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Open Kinkané</a></p>
      <p>Happy reading,<br/>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nHere's your reading summary for the week:\n\n📖 Books added to your shelf: ${booksAdded}\n📖 New recommendations waiting: ${newRecommendations}\n📖 Trending among readers: ${trendingBook}\n📖 Recommended for you this week: ${featuredBook} by ${featuredAuthor}\n\nKeep exploring, saving, and discovering stories you'll love.\n\nhttps://kinkane.com\n\nHappy reading,\nThe Kinkané Team`,
  });
}
