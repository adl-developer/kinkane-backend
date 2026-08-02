import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { config } from '../../config';

export interface SubscriptionConfirmedPayload {
  plan: 'monthly' | 'annual';
  isFounding: boolean;
  /** ISO timestamp of the first renewal, or null if Stripe didn't report one. */
  currentPeriodEnd: string | null;
}

/**
 * Sent when a subscription first becomes active. Deliberately not a receipt —
 * Stripe emails those itself, and duplicating them just trains people to ignore
 * both. This one confirms what they now have access to.
 */
export async function sendSubscriptionConfirmedEmail(
  to: string,
  name: string,
  payload: SubscriptionConfirmedPayload,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Welcome to Kinkané Plus';
  const planLabel = payload.plan === 'annual' ? 'annual' : 'monthly';

  const renewalDate = payload.currentPeriodEnd
    ? new Date(payload.currentPeriodEnd).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  const foundingLine = payload.isFounding
    ? p(
        "As a <strong>Founding Member</strong>, you've locked in your introductory price for your first term.",
      )
    : '';

  const renewalLine = renewalDate
    ? p(`Your ${planLabel} membership renews on <strong>${renewalDate}</strong>.`)
    : p(`Your ${planLabel} membership is now active.`);

  const body = [
    greeting(safeName),
    p('Your Kinkané Plus membership is live. From here on, Kinkané remembers.'),
    foundingLine,
    renewalLine,
    p(
      'Your bookshelf, your reading history and your personalised Explore page are all unlocked — and every book you save teaches Kinkané a little more about what you love.',
    ),
    ctaButton('Start exploring', `${config.appUrl}/explore`),
    signOff('Happy reading.'),
  ]
    .filter(Boolean)
    .join('\n');

  const textRenewal = renewalDate
    ? `Your ${planLabel} membership renews on ${renewalDate}.`
    : `Your ${planLabel} membership is now active.`;
  const textFounding = payload.isFounding
    ? "\n\nAs a Founding Member, you've locked in your introductory price for your first term."
    : '';

  await sgMail.send({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nYour Kinkané Plus membership is live. From here on, Kinkané remembers.${textFounding}\n\n${textRenewal}\n\nYour bookshelf, your reading history and your personalised Explore page are all unlocked — and every book you save teaches Kinkané a little more about what you love.\n\n${config.appUrl}/explore\n\nHappy reading.\n\nThe Kinkané Team`,
  });
}
