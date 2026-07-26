import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout } from '../lib/layout';

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
 * Always include an unsubscribe link in htmlBody/textBody — required by CAN-SPAM/GDPR.
 * The branded shell already includes a footer Unsubscribe link.
 */
export async function sendNewsletterEmail(
  to: string,
  payload: NewsletterPayload,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: payload.subject,
    html: emailLayout(payload.title, payload.htmlBody),
    text: payload.textBody,
    trackingSettings: {
      clickTracking: { enable: true },
      openTracking: { enable: true },
    },
  });
}
