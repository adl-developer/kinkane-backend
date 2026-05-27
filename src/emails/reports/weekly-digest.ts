import { sgMail, FROM } from '../../lib/sendgrid';

export interface WeeklyDigestPayload {
  name: string;
  booksRead: number;
  topGenre: string;
  newRecommendationsCount: number;
}

/**
 * Weekly reading digest sent to active users every Monday morning.
 * Triggered by the weekly-digest cron job.
 */
export async function sendWeeklyDigestEmail(to: string, payload: WeeklyDigestPayload): Promise<void> {
  const { name, booksRead, topGenre, newRecommendationsCount } = payload;

  await sgMail.send({
    to,
    from: FROM,
    subject: `Your Kinkane week in review 📚`,
    html: `
      <p>Hi ${name}, here's your week on Kinkane:</p>
      <ul>
        <li>📖 <strong>${booksRead}</strong> book${booksRead === 1 ? '' : 's'} tracked</li>
        <li>🏷️ Top genre this week: <strong>${topGenre}</strong></li>
        <li>✨ <strong>${newRecommendationsCount}</strong> new recommendations waiting for you</li>
      </ul>
      <p><a href="https://kinkane.com/recommendations" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">See Your Picks</a></p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nYour week on Kinkane:\n- ${booksRead} book${booksRead === 1 ? '' : 's'} tracked\n- Top genre: ${topGenre}\n- ${newRecommendationsCount} new recommendations\n\nSee your picks: https://kinkane.com/recommendations\n\nThe Kinkane Team`,
  });
}
