import { sgMail, FROM } from '../../lib/sendgrid';

/**
 * Sends an email verification link to the user.
 * @param verificationUrl - The full signed URL the user should click to verify.
 */
export async function sendVerifyEmail(to: string, name: string, verificationUrl: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Verify your Kinkane email address',
    html: `
      <p>Hi ${name},</p>
      <p>Please verify your email address by clicking the button below. This link expires in 24 hours.</p>
      <p><a href="${verificationUrl}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email</a></p>
      <p>If you didn't create a Kinkane account, you can safely ignore this email.</p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nVerify your email address:\n${verificationUrl}\n\nThis link expires in 24 hours.\n\nThe Kinkane Team`,
  });
}
