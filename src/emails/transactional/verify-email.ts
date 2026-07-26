import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, otpDisplay, escapeHtml, p } from '../lib/layout';

export async function sendVerifyEmail(
  to: string,
  name: string,
  otp: string,
  expiryMinutes: number = 15,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'One more step to start reading';

  const body = [
    p(`Hi ${safeName},`),
    p('Please verify your email address to complete your Kinkané account setup.'),
    p("Once verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes."),
    p('Use the verification code below to continue:'),
    otpDisplay(otp, expiryMinutes),
    `<p style="margin:24px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#888888;">If you didn't create a Kinkané account, you can safely ignore this email.</p>`,
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nPlease verify your email address to complete your Kinkané account setup.\n\nOnce verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes.\n\nYour verification code: ${otp}\n\nThis code will expire in ${expiryMinutes} minutes.\n\nIf you didn't create a Kinkané account, you can safely ignore this email.\n\nThe Kinkané Team`,
  });
}
