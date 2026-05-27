import { sgMail, FROM } from '../../lib/sendgrid';

/**
 * Sent when a user's trial is approaching expiry (e.g. 7 days before end).
 * @param daysLeft - Number of days remaining in the trial.
 */
export async function sendTrialEndingEmail(to: string, name: string, daysLeft: number): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: `Your Kinkane trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: `
      <p>Hi ${name},</p>
      <p>Just a heads-up — your Kinkane Plus trial ends in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>.</p>
      <p>After it ends, you'll lose access to personalised recommendations and unlimited book discovery.</p>
      <p><a href="https://kinkane.com/subscribe" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Keep Kinkane Plus</a></p>
      <p>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nYour Kinkane Plus trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.\n\nSubscribe to keep access: https://kinkane.com/subscribe\n\nThe Kinkane Team`,
  });
}
