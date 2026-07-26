import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Reset your password';

  const body = [
    greeting(safeName),
    p('We received a request to reset your Kinkané password.'),
    p('Click the button below to create a new password:'),
    ctaButton('Reset Password', resetUrl),
    signOff("If you didn't request a password reset, you can safely ignore this email. Your account remains secure."),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: 'Reset your Kinkané password',
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nWe received a request to reset your Kinkané password.\n\nClick the link below to create a new password:\n${resetUrl}\n\nIf you didn't request a password reset, you can safely ignore this email. Your account remains secure.\n\nThe Kinkané Team`,
  });
}
