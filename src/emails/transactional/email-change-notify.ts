import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, escapeHtml, p } from '../lib/layout';

export async function sendEmailChangeNotifyEmail(to: string, name: string, cancelUrl: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Email change requested';

  const body = [
    p(`Hi ${safeName},`),
    p('A request has been made to change the email address on your Kinkané account.'),
    p('If you made this request, you can ignore this message — the change will complete once you verify the new address.'),
    p('If you did <strong>not</strong> make this request, please cancel it immediately:'),
    `<p style="margin:0 0 16px;"><a href="${cancelUrl}" style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;font-weight:bold;">Cancel this email change</a></p>`,
    p('This link will expire in 15 minutes.'),
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: 'Email change requested for your Kinkané account',
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nA request has been made to change the email address on your Kinkané account.\n\nIf you made this request, you can ignore this message.\n\nIf you did NOT make this request, cancel it here:\n${cancelUrl}\n\nThis link will expire in 15 minutes.\n\nThe Kinkané Team`,
  });
}
