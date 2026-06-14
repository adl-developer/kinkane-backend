import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendPasswordChangedEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your password was changed',
    html: `
      <p>Hi ${name},</p>
      <p>This is a confirmation that your Kinkané password was successfully updated.</p>
      <p>If you made this change, no further action is required.</p>
      <p>If you did not change your password, please contact us immediately.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nThis is a confirmation that your Kinkané password was successfully updated.\n\nIf you made this change, no further action is required.\n\nIf you did not change your password, please contact us immediately.\n\nThe Kinkané Team`,
  });
}
