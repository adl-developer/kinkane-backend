import { sgMail, FROM } from '../../lib/sendgrid';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export async function sendFollowRequestEmail(to: string, receiverName: string, senderName: string): Promise<void> {
  const safeReceiver = escapeHtml(receiverName);
  const safeSender = escapeHtml(senderName);

  await sgMail.send({
    to,
    from: FROM,
    subject: `${senderName} wants to follow you on Kinkané`,
    html: `
      <p>Hi ${safeReceiver},</p>
      <p><strong>${safeSender}</strong> has sent you a follow request on Kinkané.</p>
      <p>Open the app to accept or ignore the request.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${receiverName},\n\n${senderName} has sent you a follow request on Kinkané.\n\nOpen the app to accept or ignore the request.\n\nThe Kinkané Team`,
  });
}

export async function sendFollowAcceptedEmail(to: string, senderName: string, accepterName: string): Promise<void> {
  const safeSender = escapeHtml(senderName);
  const safeAccepter = escapeHtml(accepterName);

  await sgMail.send({
    to,
    from: FROM,
    subject: `${accepterName} accepted your follow request`,
    html: `
      <p>Hi ${safeSender},</p>
      <p><strong>${safeAccepter}</strong> has accepted your follow request on Kinkané.</p>
      <p>You can now see their reading activity.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${senderName},\n\n${accepterName} has accepted your follow request on Kinkané.\n\nYou can now see their reading activity.\n\nThe Kinkané Team`,
  });
}
