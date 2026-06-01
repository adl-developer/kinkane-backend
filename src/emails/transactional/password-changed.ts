import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendPasswordChangedEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your Kinkane password was changed',
    html: `
      <p>Hi ${name},</p>
      <p>Your Kinkane password was successfully changed.</p>
      <p>If you made this change, no action is needed.</p>
      <p>If you didn't change your password, please <a href="mailto:support@kinkane.com">contact support</a> immediately.</p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nYour Kinkane password was successfully changed.\n\nIf you made this change, no action is needed.\n\nIf you didn't change your password, contact support immediately: support@kinkane.com\n\nThe Kinkane Team`,
  });
}
