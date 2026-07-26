import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

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
  const safeName = escapeHtml(name);
  const safeTrending = escapeHtml(trendingBook);
  const safeFeatured = escapeHtml(featuredBook);
  const safeAuthor = escapeHtml(featuredAuthor);
  const title = 'Your week in books';

  const statRows = [
    ['Books added to your shelf', String(booksAdded)],
    ['New recommendations waiting', String(newRecommendations)],
    ['Trending among readers', safeTrending],
    [`Recommended for you this week`, `<strong>${safeFeatured}</strong> by ${safeAuthor}`],
  ]
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:10px 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#555555;border-bottom:1px solid #F0EAE0;">${label}</td>
          <td style="padding:10px 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#1A1A1A;border-bottom:1px solid #F0EAE0;text-align:right;">${value}</td>
        </tr>`,
    )
    .join('');

  const statsTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0 24px;border:1px solid #E8E0D0;border-radius:6px;border-collapse:separate;border-spacing:0;overflow:hidden;">
    ${statRows}
  </table>`;

  const body = [
    p(`Hi ${safeName},`),
    p("Here's your reading summary for the week:"),
    statsTable,
    p("Keep exploring, saving, and discovering stories you'll love."),
    ctaButton('Open Kinkané', 'https://kinkane.com'),
    p('Happy reading,'),
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your week in books',
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\nHere's your reading summary for the week:\n\nBooks added to your shelf: ${booksAdded}\nNew recommendations waiting: ${newRecommendations}\nTrending among readers: ${trendingBook}\nRecommended for you this week: ${featuredBook} by ${featuredAuthor}\n\nKeep exploring, saving, and discovering stories you'll love.\n\nhttps://kinkane.com\n\nHappy reading,\nThe Kinkané Team`,
  });
}
