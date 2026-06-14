import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Reset your Kinkané password',
    html: `
      <p>Hi ${name},</p>
      <p>We received a request to reset your Kinkané password.</p>
      <p>Click the button below to create a new password:</p>
      <p><a href="${resetUrl}" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Reset Password</a></p>
      <p>If you didn't request a password reset, you can safely ignore this email. Your account remains secure.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nWe received a request to reset your Kinkané password.\n\nClick the link below to create a new password:\n${resetUrl}\n\nIf you didn't request a password reset, you can safely ignore this email. Your account remains secure.\n\nThe Kinkané Team`,
  });
}
