import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendAccountDeletedEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your Kinkane account has been deleted',
    html: `
      <p>Hi ${name},</p>
      <p>Your Kinkane account has been permanently deleted. All your data — your library, preferences, and reading history — has been removed.</p>
      <p>We're sorry to see you go. If you ever want to come back, you're always welcome to create a new account.</p>
      <p>If you didn't request this deletion, please <a href="mailto:support@kinkane.com">contact support</a> immediately.</p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nYour Kinkane account has been permanently deleted. All your data — your library, preferences, and reading history — has been removed.\n\nWe're sorry to see you go. If you ever want to come back, you're always welcome to create a new account.\n\nIf you didn't request this deletion, contact support immediately: support@kinkane.com\n\nThe Kinkane Team`,
  });
}
