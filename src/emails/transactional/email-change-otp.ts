import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, otpDisplay, greeting, signOff, escapeHtml, p } from '../lib/layout';

export async function sendEmailChangeOtpEmail(
  to: string,
  name: string,
  otp: string,
  expiryMinutes: number = 15,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Confirm your email change';

  const body = [
    greeting(safeName),
    p('We received a request to change the email address associated with your Kinkané account.'),
    p('Use the verification code below to continue:'),
    otpDisplay(otp, expiryMinutes),
    signOff("If you didn't request this change, please ignore this email."),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nWe received a request to change the email address associated with your Kinkané account.\n\nYour verification code: ${otp}\n\nThis code will expire in ${expiryMinutes} minutes.\n\nIf you didn't request this change, please ignore this email.\n\nThe Kinkané Team`,
  });
}
