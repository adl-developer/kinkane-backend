import { sgMail, FROM } from '../../lib/sendgrid';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export async function sendPostLikeEmail(
  to: string,
  name: string,
  likerName: string,
  bookTitle: string,
): Promise<void> {
  const safeName = escapeHtml(name);
  const safeLiker = escapeHtml(likerName);
  const safeBook = escapeHtml(bookTitle);

  await sgMail.send({
    to,
    from: FROM,
    subject: `${likerName} liked your review`,
    html: `
      <p>Hi ${safeName},</p>
      <p><strong>${safeLiker}</strong> liked your review of <em>${safeBook}</em>. Looks like your taste resonates.</p>
      <p><a href="https://kinkane.com" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View in App</a></p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\n${likerName} liked your review of "${bookTitle}". Looks like your taste resonates.\n\nhttps://kinkane.com\n\nThe Kinkané Team`,
  });
}
