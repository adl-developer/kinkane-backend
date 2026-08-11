import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

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
    ['Recommended for you this week', `<strong>${safeFeatured}</strong> by ${safeAuthor}`],
  ]
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:10px 16px;font-family:${SANS};font-size:14px;color:#52514E;border-bottom:1px solid #E8E8E7;line-height:22.75px;">${label}</td>
          <td style="padding:10px 16px;font-family:${SANS};font-size:14px;color:#262626;border-bottom:1px solid #E8E8E7;text-align:right;line-height:22.75px;">${value}</td>
        </tr>`,
    )
    .join('');

  const statsTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0 8px;border:1px solid #E8E8E7;border-radius:6px;border-collapse:separate;border-spacing:0;overflow:hidden;">
    ${statRows}
  </table>`;

  const body = [
    greeting(safeName),
    p("Here's your reading summary for the week:"),
    statsTable,
    p("Keep exploring, saving, and discovering stories you'll love."),
    ctaButton('Open Kinkané', config.appUrl),
    signOff('Happy reading,'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: 'Your week in books',
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\nHere's your reading summary for the week:\n\nBooks added to your shelf: ${booksAdded}\nNew recommendations waiting: ${newRecommendations}\nTrending among readers: ${trendingBook}\nRecommended for you this week: ${featuredBook} by ${featuredAuthor}\n\nKeep exploring, saving, and discovering stories you'll love.\n\n${config.appUrl}\n\nHappy reading,\nThe Kinkané Team`,
  });
}
