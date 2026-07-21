import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendVerifyEmail(
  to: string,
  name: string,
  otp: string,
  expiryMinutes: number = 15,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'One more step to start reading',
    html: `
      <p>Hi ${name},</p>
      <p>Please verify your email address to complete your Kinkané account setup.</p>
      <p>Once verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes.</p>
      <p>Use the verification code below to continue:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;margin:24px 0;">${otp}</p>
      <p>This code will expire in ${expiryMinutes} minutes.</p>
      <p>If you didn't create a Kinkané account, you can safely ignore this email.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nPlease verify your email address to complete your Kinkané account setup.\n\nOnce verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes.\n\nYour verification code: ${otp}\n\nThis code will expire in ${expiryMinutes} minutes.\n\nIf you didn't create a Kinkané account, you can safely ignore this email.\n\nThe Kinkané Team`,
  });
}
