import { sgMail, FROM } from '../../lib/sendgrid';

export interface NewsletterPayload {
  subject: string;
  preheader?: string;  // preview text shown in inbox before opening
  htmlBody: string;
  textBody: string;
}

/**
 * Sends a marketing newsletter to a single recipient.
 * For bulk campaigns, batch recipients via SendGrid's batch send or marketing
 * campaigns API rather than calling this in a loop.
 *
 * Always include an unsubscribe link in htmlBody/textBody — required by CAN-SPAM/GDPR.
 */
export async function sendNewsletterEmail(
  to: string,
  payload: NewsletterPayload,
): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: payload.subject,
    html: payload.htmlBody,
    text: payload.textBody,
    // Tells SendGrid to track unsubscribes via its suppression groups
    trackingSettings: {
      clickTracking: { enable: true },
      openTracking: { enable: true },
    },
  });
}
