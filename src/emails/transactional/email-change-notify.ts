import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendEmailChangeNotifyEmail(to: string, name: string, cancelUrl: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Email change requested for your Kinkané account',
    html: `
      <p>Hi ${name},</p>
      <p>A request has been made to change the email address on your Kinkané account.</p>
      <p>If you made this request, you can ignore this message — the change will complete once you verify the new address.</p>
      <p>If you did <strong>not</strong> make this request, please cancel it immediately using the link below:</p>
      <p><a href="${cancelUrl}">Cancel this email change</a></p>
      <p>This link will expire in 15 minutes.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nA request has been made to change the email address on your Kinkané account.\n\nIf you made this request, you can ignore this message.\n\nIf you did NOT make this request, cancel it here:\n${cancelUrl}\n\nThis link will expire in 15 minutes.\n\nThe Kinkané Team`,
  });
}
