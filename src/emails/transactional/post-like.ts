import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export async function sendPostLikeEmail(
  to: string,
  name: string,
  likerName: string,
  bookTitle: string,
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeLiker = escapeHtml(likerName);
  const safeBook = escapeHtml(bookTitle);
  const title = 'Someone liked your review';

  const body = [
    p(`Hi ${safeName},`),
    p(`<strong>${safeLiker}</strong> liked your review of <em>${safeBook}</em>. Looks like your taste resonates.`),
    ctaButton('View in App', 'https://kinkane.com'),
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: `${likerName} liked your review`,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\n${likerName} liked your review of "${bookTitle}". Looks like your taste resonates.\n\nhttps://kinkane.com\n\nThe Kinkané Team`,
  });
}
