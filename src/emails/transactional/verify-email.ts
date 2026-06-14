import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendVerifyEmail(to: string, name: string, verificationUrl: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'One more step to start reading',
    html: `
      <p>Hi ${name},</p>
      <p>Please verify your email address to complete your Kinkané account setup.</p>
      <p>Once verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes.</p>
      <p>Verify your email below:</p>
      <p><a href="${verificationUrl}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email</a></p>
      <p>If you didn't create a Kinkané account, you can safely ignore this email.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nPlease verify your email address to complete your Kinkané account setup.\n\nOnce verified, you'll be able to save books, build your bookshelf, and receive personalised recommendations tailored to your reading tastes.\n\nVerify your email:\n${verificationUrl}\n\nIf you didn't create a Kinkané account, you can safely ignore this email.\n\nThe Kinkané Team`,
  });
}
