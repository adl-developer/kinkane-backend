import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

/**
 * The admin console's "forgot password" email. Separate from the customer one so
 * the copy says which account it is about — a staff member who also uses the
 * app should not have to guess which password a reset link is for.
 */
export async function sendAdminPasswordResetEmail(
  to: string,
  name: string,
  resetUrl: string,
  expiryMinutes: number,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Reset your admin console password';

  const body = [
    greeting(safeName),
    p('We received a request to reset your password for the Kinkané admin console.'),
    p(`Click the button below to choose a new one. The link works once and expires in ${expiryMinutes} minutes.`),
    ctaButton('Reset Password', resetUrl),
    signOff("If you didn't ask for this, you can ignore this email — your password stays as it is. If it keeps happening, let the team know."),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: 'Reset your Kinkané admin console password',
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nWe received a request to reset your password for the Kinkané admin console.\n\nOpen the link below to choose a new one. The link works once and expires in ${expiryMinutes} minutes.\n${resetUrl}\n\nIf you didn't ask for this, you can ignore this email — your password stays as it is. If it keeps happening, let the team know.\n\nThe Kinkané Team`,
  });
}
