import { sgMail, FROM } from '../../lib/sendgrid';

const PREVIEW_MAX_LENGTH = 120;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

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

  await sgMail.send({
    to,
    from: FROM,
    subject: `${commenterName} commented on your review`,
    html: `
      <p>Hi ${safeName},</p>
      <p><strong>${safeCommenter}</strong> replied to your review of <em>${safeBook}</em>:</p>
      <blockquote style="border-left:3px solid #e0e0e0;margin:16px 0;padding:8px 16px;color:#555;">${safePreview}</blockquote>
      <p><a href="https://kinkane.com" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View in App</a></p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\n${commenterName} replied to your review of "${bookTitle}":\n\n"${truncate(commentPreview, PREVIEW_MAX_LENGTH)}"\n\nOpen Kinkané to reply.\n\nhttps://kinkane.com\n\nThe Kinkané Team`,
  });
}
