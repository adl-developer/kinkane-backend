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
   * The guest's tracking code, or null for a signed-in buyer who has order
   * history instead.
   *
   * Printed as a code to copy, never as a link. A token in a URL leaks through
   * Referer headers, browser history and any analytics on the landing page —
   * which is why checkout.service says never to put it in one. In an inbox it
   * is as durable as a link and leaks nowhere.
   */
  trackingCode: string | null;
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
 * That last part is the reason this email exists at all. A guest's tracking
 * code is handed to the client exactly once, in the checkout response. Before
 * this, closing the tab meant the order became permanently unreachable to the
 * person who paid for it.
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

  // Guests only. A signed-in buyer finds this under their account, and printing
  // a credential they do not need is a credential that can leak for no reason.
  const tracking = payload.trackingCode
    ? [
        p(
          '<strong>Keep this to track your order.</strong> You checked out as a guest, so this code is the only way to find this order again — or to attach it to an account later.',
        ),
        `<div style="margin:16px 0;padding:16px;background:#f6f4ef;border-radius:8px;
             font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;
             color:#1a1a1a;word-break:break-all;">${escapeHtml(payload.trackingCode)}</div>`,
        p(`Enter it with your order number <strong>${escapeHtml(payload.reference)}</strong> on the Track My Order page.`),
      ].join('\n')
    : p('You can see this order any time under <strong>My Account</strong>.');

  const body = [
    greeting(name ? escapeHtml(name) : 'there'),
    p(`Thank you — your order <strong>${escapeHtml(payload.reference)}</strong> is confirmed and we are getting it ready.`),
    orderTable,
    address,
    tracking,
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
    payload.trackingCode
      ? `Keep this to track your order — it is the only way to find this order again:\n${payload.trackingCode}\nUse it with your order number ${payload.reference} on the Track My Order page.`
      : 'You can see this order any time under My Account.',
    '',
    'The Kinkané Team',
  ]
    .filter((line) => line !== '')
    .join('\n');

  await sendEmail({ to, from: FROM, subject: title, html: emailLayout(title, body), text });
}
