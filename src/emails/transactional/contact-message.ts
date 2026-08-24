import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, escapeHtml, p } from '../lib/layout';
import { config } from '../../config';

/**
 * The "someone wrote in" notification, sent to the support inbox rather than to
 * a customer.
 *
 * `replyTo` is the sender's address, so answering it in a mail client goes
 * straight back to them. The From stays our own verified sender — putting the
 * customer's address there would fail SPF and land the whole thing in spam.
 */
export async function sendContactMessageEmail(payload: {
  id: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  userId: number | null;
}): Promise<void> {
  const title = `Contact form: ${payload.subject}`;

  const body = [
    p(`<strong>From:</strong> ${escapeHtml(payload.name)} &lt;${escapeHtml(payload.email)}&gt;`),
    p(
      `<strong>Account:</strong> ${
        payload.userId === null ? 'not signed in' : `user #${payload.userId}`
      }`,
    ),
    p(`<strong>Reference:</strong> #${payload.id}`),
    // The message is escaped and then given back its line breaks — a customer
    // pasting an order reference on its own line should not arrive as one run-on
    // paragraph.
    p(escapeHtml(payload.message).replace(/\n/g, '<br />')),
  ].join('\n');

  await sendEmail({
    to: config.email.supportInbox,
    from: FROM,
    replyTo: payload.email,
    subject: title,
    html: emailLayout(title, body),
    text: `From: ${payload.name} <${payload.email}>\nAccount: ${
      payload.userId === null ? 'not signed in' : `user #${payload.userId}`
    }\nReference: #${payload.id}\n\n${payload.message}`,
  });
}
