import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendEmailChangeNotifyEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Your email address has been updated',
    html: `
      <p>Hi ${name},</p>
      <p>The email address associated with your Kinkané account has been successfully updated.</p>
      <p>Future account notifications and recommendations will now be sent to your new email address.</p>
      <p>If you did not make this change, please contact us immediately.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nThe email address associated with your Kinkané account has been successfully updated.\n\nFuture account notifications and recommendations will now be sent to your new email address.\n\nIf you did not make this change, please contact us immediately.\n\nThe Kinkané Team`,
  });
}
