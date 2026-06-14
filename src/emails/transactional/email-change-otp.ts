import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendEmailChangeOtpEmail(
  to: string,
  name: string,
  otp: string,
  expiryMinutes: number = 15,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Confirm your email change',
    html: `
      <p>Hi ${name},</p>
      <p>We received a request to change the email address associated with your Kinkané account.</p>
      <p>Use the verification code below to continue:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;margin:24px 0;">${otp}</p>
      <p>This code will expire in ${expiryMinutes} minutes.</p>
      <p>If you didn't request this change, please ignore this email.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nWe received a request to change the email address associated with your Kinkané account.\n\nYour verification code: ${otp}\n\nThis code will expire in ${expiryMinutes} minutes.\n\nIf you didn't request this change, please ignore this email.\n\nThe Kinkané Team`,
  });
}
