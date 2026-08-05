import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export interface NewsletterPayload {
  subject: string;
  title: string;         // hero band headline (required for branded layout)
  preheader?: string;    // preview text shown in inbox before opening
  htmlBody: string;      // inner body content only — the layout shell is added here
  textBody: string;
}

/**
 * Sends a marketing newsletter to a single recipient.
 * For bulk campaigns, batch recipients via SendGrid's batch send or marketing
 * campaigns API rather than calling this in a loop.
 *
 * Do not call this directly — enqueue a 'newsletter' job instead. The queue
 * worker checks the recipient's marketingEmails preference before it gets
 * here; this function does not, and has no user context to check with.
 *
 * The branded shell renders the footer Unsubscribe link from the address
 * passed here, which CAN-SPAM/GDPR require on marketing mail.
 */
export async function sendNewsletterEmail(
  to: string,
  payload: NewsletterPayload,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: payload.subject,
    html: emailLayout(payload.title, payload.htmlBody, unsubscribeUrl(to)),
    text: payload.textBody,
    trackingSettings: {
      clickTracking: { enable: true },
      openTracking: { enable: true },
    },
  });
}
