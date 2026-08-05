import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { config } from '../../config';

/**
 * Sent when a member schedules a cancellation. They keep full access until the
 * end of the period they've paid for, which is the main thing this email exists
 * to say — and, since nothing is deleted on downgrade, that their bookshelf and
 * history will still be there if they come back.
 */
export async function sendSubscriptionCancelledEmail(
  to: string,
  name: string,
  accessEndsAt: string | null,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Your Kinkané Plus membership is ending';

  const endsDate = accessEndsAt
    ? new Date(accessEndsAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  const accessLine = endsDate
    ? p(`You'll keep full Plus access until <strong>${endsDate}</strong>.`)
    : p("You'll keep full Plus access until the end of your current billing period.");

  const body = [
    greeting(safeName),
    p("Your Kinkané Plus membership is set to end, and we've cancelled your next payment."),
    accessLine,
    p(
      'Your bookshelf and reading history stay exactly where they are — nothing is deleted. If you come back, Kinkané picks up where you left off.',
    ),
    ctaButton('Change your mind?', `${config.appUrl}/account/subscription`),
    signOff('Thank you for reading with us.'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nYour Kinkané Plus membership is set to end, and we've cancelled your next payment.\n\n${endsDate ? `You'll keep full Plus access until ${endsDate}.` : "You'll keep full Plus access until the end of your current billing period."}\n\nYour bookshelf and reading history stay exactly where they are — nothing is deleted. If you come back, Kinkané picks up where you left off.\n\n${config.appUrl}/account/subscription\n\nThank you for reading with us.\n\nThe Kinkané Team`,
  });
}
