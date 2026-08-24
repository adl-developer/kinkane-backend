import { Resend } from 'resend';
import { config } from '../config';

const resend = new Resend(config.email.apiKey);

/**
 * Shared sender identity used by all outgoing emails.
 *
 * Resend takes the sender as a single RFC 5322 string rather than the
 * {email, name} pair SendGrid used, so the display name is folded in here.
 */
export const FROM = `${config.email.fromName} <${config.email.from}>` as const;

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Where a reply should go, when that is not the From address. Used by the
   * contact-form notification so support can answer the customer directly;
   * putting the customer's address in From instead would fail SPF and land the
   * message in spam.
   */
  replyTo?: string;
}

/**
 * Sends one email and throws if the provider rejects it.
 *
 * The throw matters: Resend resolves with `{ data, error }` instead of
 * rejecting on failure, so without this a rejected send would look like a
 * success to the BullMQ worker and never be retried.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const { data, error } = await resend.emails.send({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(msg.replyTo && { replyTo: msg.replyTo }),
  });

  if (error) {
    throw new Error(`Resend rejected email to ${msg.to}: ${error.name} — ${error.message}`);
  }

  if (!data) {
    throw new Error(`Resend returned no message id for email to ${msg.to}`);
  }
}
