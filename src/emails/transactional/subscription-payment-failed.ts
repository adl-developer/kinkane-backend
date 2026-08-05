import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { config } from '../../config';

/**
 * Sent when a renewal charge fails.
 *
 * Tone matters here: the overwhelmingly common cause is an expired card, not
 * an unwilling customer. Access continues while Stripe retries, and the email
 * says so — a message that implies they've already lost their bookshelf is how
 * a recoverable payment failure turns into a cancellation.
 */
export async function sendSubscriptionPaymentFailedEmail(
  to: string,
  name: string,
  amountCents: number | null,
  currency: string | null,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'We couldn’t process your Kinkané Plus payment';

  const amount =
    amountCents != null && currency
      ? new Intl.NumberFormat('en-GB', {
          style: 'currency',
          currency: currency.toUpperCase(),
        }).format(amountCents / 100)
      : null;

  const amountLine = amount
    ? p(`We tried to charge <strong>${amount}</strong> for your membership, and it didn't go through.`)
    : p("We tried to charge for your membership, and it didn't go through.");

  const body = [
    greeting(safeName),
    amountLine,
    p(
      'This is usually just an expired or replaced card. <strong>Your Plus access is still active</strong> — we’ll retry over the next few days, and updating your card takes a moment.',
    ),
    ctaButton('Update payment details', `${config.appUrl}/account/subscription`),
    signOff('If you think this is a mistake, just reply to this email.'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\n${amount ? `We tried to charge ${amount} for your membership, and it didn't go through.` : "We tried to charge for your membership, and it didn't go through."}\n\nThis is usually just an expired or replaced card. Your Plus access is still active — we'll retry over the next few days, and updating your card takes a moment.\n\n${config.appUrl}/account/subscription\n\nIf you think this is a mistake, just reply to this email.\n\nThe Kinkané Team`,
  });
}
