import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

export async function sendEmailChangeNotifyEmail(to: string, name: string, cancelUrl: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Email change requested';

  const body = [
    greeting(safeName),
    p('A request has been made to change the email address on your Kinkané account.'),
    p('If you made this request, you can ignore this message — the change will complete once you verify the new address.'),
    p('If you did <strong>not</strong> make this request, please cancel it immediately:'),
    ctaButton('Cancel Email Change', cancelUrl),
    signOff('This link will expire in 15 minutes.'),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: 'Email change requested for your Kinkané account',
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nA request has been made to change the email address on your Kinkané account.\n\nIf you made this request, you can ignore this message.\n\nIf you did NOT make this request, cancel it here:\n${cancelUrl}\n\nThis link will expire in 15 minutes.\n\nThe Kinkané Team`,
  });
}
