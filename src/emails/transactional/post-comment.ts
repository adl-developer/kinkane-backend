import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, quoteBlock, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

const PREVIEW_MAX_LENGTH = 120;

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max).trimEnd()}…` : str;
}

export async function sendPostCommentEmail(
  to: string,
  name: string,
  commenterName: string,
  bookTitle: string,
  commentPreview: string,
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeCommenter = escapeHtml(commenterName);
  const safeBook = escapeHtml(bookTitle);
  const safePreview = escapeHtml(truncate(commentPreview, PREVIEW_MAX_LENGTH));
  const title = 'Someone commented on your review';

  const body = [
    greeting(safeName),
    p(`<strong>${safeCommenter}</strong> replied to your review of <em>${safeBook}</em>:`),
    quoteBlock(safePreview),
    ctaButton('View in App', 'https://kinkane.com'),
    signOff(),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: `${commenterName} commented on your review`,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\n${commenterName} replied to your review of "${bookTitle}":\n\n"${truncate(commentPreview, PREVIEW_MAX_LENGTH)}"\n\nOpen Kinkané to reply.\n\nhttps://kinkane.com\n\nThe Kinkané Team`,
  });
}
