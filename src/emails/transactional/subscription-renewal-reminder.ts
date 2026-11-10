import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { appLink } from '../../lib/app-link';
import { formatMoneyForDisplay as money } from '../../lib/money';

export interface SubscriptionRenewalReminderPayload {
  plan: 'monthly' | 'annual';
  /** ISO timestamp of the renewal charge. */
  renewsAt: string;
  /** What the renewal will charge, in minor units. */
  amountCents: number;
  currency: string;
  /** The founding price they paid this period; set only when this renewal moves them to standard. */
  foundingAmountCents?: number | null;
}

/**
 * Sent a week before every Stripe renewal. When the renewal is the one that
 * ends the founding price, it says so plainly with both amounts: a price rise
 * nobody was told about is how a renewal becomes a chargeback.
 */
export async function sendSubscriptionRenewalReminderEmail(
  to: string,
  name: string,
  payload: SubscriptionRenewalReminderPayload,
): Promise<void> {
  const safeName = escapeHtml(name);
  const planLabel = payload.plan === 'annual' ? 'annual' : 'monthly';
  const date = new Date(payload.renewsAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const amount = money(payload.amountCents, payload.currency);
  const foundingEnds = payload.foundingAmountCents != null;
  const founding = foundingEnds ? money(payload.foundingAmountCents!, payload.currency) : '';

  const title = foundingEnds
    ? 'Your Founding Member price ends soon'
    : 'Your Kinkané Plus membership renews soon';

  const lines = foundingEnds
    ? [
        `Your ${planLabel} Kinkané Plus membership renews on <strong>${date}</strong>.`,
        `Your Founding Member price of ${founding} ends with this period. From this renewal you'll pay the standard price of <strong>${amount}</strong> a ${payload.plan === 'annual' ? 'year' : 'month'}.`,
        `You don't need to do anything to keep your membership. If you'd like to change plan or cancel, you can do it any time before ${date}.`,
      ]
    : [
        `Your ${planLabel} Kinkané Plus membership renews on <strong>${date}</strong>, and we'll charge <strong>${amount}</strong> to your saved payment method.`,
        `You don't need to do anything to keep your membership. If you'd like to change plan or cancel, you can do it any time before ${date}.`,
      ];

  const body = [
    greeting(safeName),
    ...lines.map((l) => p(l)),
    ctaButton('Manage your membership', appLink('/account/subscription')),
    signOff('Thank you for reading with us.'),
  ].join('\n');

  const text = `Hi ${name},\n\n${lines.map((l) => l.replace(/<\/?strong>/g, '')).join('\n\n')}\n\n${appLink('/account/subscription')}\n\nThank you for reading with us.\n\nThe Kinkané Team`;

  await sendEmail({ to, from: FROM, subject: title, html: emailLayout(title, body), text });
}
