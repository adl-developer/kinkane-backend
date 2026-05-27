import { sgMail, FROM } from '../../lib/sendgrid';

/**
 * Sends a password reset link.
 * @param resetUrl - The full signed URL with the reset token. Expires in 1 hour.
 */
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Reset your Kinkane password',
    html: `
      <p>Hi ${name},</p>
      <p>We received a request to reset your password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
      <p><a href="${resetUrl}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Reset Password</a></p>
      <p>If you didn't request a password reset, you can safely ignore this email. Your password won't change.</p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nReset your password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\nThe Kinkane Team`,
  });
}
