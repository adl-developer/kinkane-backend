import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { formatMinor } from '../../lib/money';

export interface OrderConfirmedItem {
  title: string;
  contributor: string | null;
  quantity: number;
  lineTotalMinor: number;
}

export interface OrderConfirmedPayload {
  reference: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  items: OrderConfirmedItem[];
  shippingLines: string[];
  /**
   * The guest's long access token, or null for a signed-in buyer who has order
   * history instead.
   *
   * Deliberately **not** printed anywhere in this email — it is a credential,
   * and the email carries only the order number. All this field does here is
   * tell a guest apart from a signed-in buyer, so we do not promise "My
   * Account" to someone who has no account.
   */
  accessToken: string | null;
}

/** Right-aligned money row for the totals block. */
function totalRow(label: string, amount: string, bold = false): string {
  const weight = bold ? 'font-weight:600;' : '';
  return `<tr>
    <td style="padding:4px 0;color:#4a4a4a;font-size:14px;${weight}">${escapeHtml(label)}</td>
    <td style="padding:4px 0;text-align:right;color:#1a1a1a;font-size:14px;${weight}">${escapeHtml(amount)}</td>
  </tr>`;
}

/**
 * Sent once payment lands, to whoever bought the books.
 *
 * **Not a payment receipt** — Stripe issues those, and sending a second one
 * trains people to ignore both. This answers the questions a receipt does not:
 * what was bought, where it is going, what the order is called, and — for a
 * guest — how to find it again.
 *
 * That last part is the reason this email exists at all. The order number and
 * the email address you ordered with are the only two things needed to track
 * an order, and this is where a guest who closed the checkout tab gets the
 * first of them back.
 */
export async function sendOrderConfirmedEmail(
  to: string,
  name: string | null,
  payload: OrderConfirmedPayload,
): Promise<void> {
  const title = `Your Kinkané order ${payload.reference}`;
  const money = (minor: number) => formatMinor(minor, payload.currency);

  const itemRows = payload.items
    .map(
      (item) => `<tr>
        <td style="padding:8px 0;color:#1a1a1a;font-size:14px;">
          ${escapeHtml(item.title)}${item.contributor ? `<br /><span style="color:#6b6b6b;font-size:13px;">${escapeHtml(item.contributor)}</span>` : ''}
          <br /><span style="color:#6b6b6b;font-size:13px;">Qty ${item.quantity}</span>
        </td>
        <td style="padding:8px 0;text-align:right;color:#1a1a1a;font-size:14px;vertical-align:top;">
          ${escapeHtml(money(item.lineTotalMinor))}
        </td>
      </tr>`,
    )
    .join('');

  const totals = [
    totalRow('Subtotal', money(payload.subtotalMinor)),
    // Only shown when there was one — a "Discount £0.00" line invites the
    // question "why didn't I get one?" on every order that never qualified.
    payload.discountMinor > 0 ? totalRow('First order discount', `-${money(payload.discountMinor)}`) : '',
    totalRow('Shipping', payload.shippingMinor === 0 ? 'Free' : money(payload.shippingMinor)),
    payload.taxMinor > 0 ? totalRow('VAT', money(payload.taxMinor)) : '',
    totalRow('Total', money(payload.totalMinor), true),
  ].join('');

  const orderTable = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
      style="border-collapse:collapse;margin:24px 0;">
    ${itemRows}
    <tr><td colspan="2" style="border-top:1px solid #e5e5e5;padding-top:8px;"></td></tr>
    ${totals}
  </table>`;

  const address = payload.shippingLines.length
    ? p(`<strong>Delivering to</strong><br />${payload.shippingLines.map(escapeHtml).join('<br />')}`)
    : '';

  // The order number is repeated large here even though it is already in the
  // subject line and the paragraph above. This is the block a customer comes
  // back to the email to find, and it is an identifier rather than a
  // credential, so there is nothing to leak by printing it for a signed-in
  // buyer too.
  const trackingBlock = [
    p('<strong>Track your order</strong> with this order number and the email address you ordered with:'),
    `<div style="margin:16px 0;padding:16px;background:#f6f4ef;border-radius:8px;text-align:center;
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;letter-spacing:3px;
         color:#1a1a1a;">${escapeHtml(payload.reference)}</div>`,
  ].join('\n');

  // Guests get nothing extra here: the claim token is deliberately kept out of
  // the email, and "My Account" is only true for a buyer who has one.
  const accountBlock = payload.accessToken
    ? ''
    : p('You can also see this order any time under <strong>My Account</strong>.');

  const body = [
    greeting(name ? escapeHtml(name) : 'there'),
    p(`Thank you — your order <strong>${escapeHtml(payload.reference)}</strong> is confirmed and we are getting it ready.`),
    orderTable,
    address,
    trackingBlock,
    accountBlock,
    signOff(),
  ].join('\n');

  const textItems = payload.items
    .map((i) => `  ${i.title}${i.contributor ? ` — ${i.contributor}` : ''} x${i.quantity}  ${money(i.lineTotalMinor)}`)
    .join('\n');

  const text = [
    `Hi ${name ?? 'there'},`,
    '',
    `Thank you — your order ${payload.reference} is confirmed and we are getting it ready.`,
    '',
    textItems,
    '',
    `Subtotal: ${money(payload.subtotalMinor)}`,
    payload.discountMinor > 0 ? `First order discount: -${money(payload.discountMinor)}` : '',
    `Shipping: ${payload.shippingMinor === 0 ? 'Free' : money(payload.shippingMinor)}`,
    payload.taxMinor > 0 ? `VAT: ${money(payload.taxMinor)}` : '',
    `Total: ${money(payload.totalMinor)}`,
    '',
    payload.shippingLines.length ? `Delivering to:\n${payload.shippingLines.join('\n')}` : '',
    '',
    `Track your order with this order number and the email address you ordered with:\n${payload.reference}`,
    '',
    payload.accessToken ? '' : 'You can also see this order any time under My Account.',
    '',
    'The Kinkané Team',
  ]
    .filter((line) => line !== '')
    .join('\n');

  await sendEmail({ to, from: FROM, subject: title, html: emailLayout(title, body), text });
}
