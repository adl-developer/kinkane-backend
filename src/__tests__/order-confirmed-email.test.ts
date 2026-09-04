import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendOrderConfirmedEmail } from '../emails/transactional/order-confirmed';

const sent: { to: string; subject: string; html: string; text: string }[] = [];

vi.mock('../lib/resend', () => ({
  FROM: 'Kinkane <no-reply@kinkane.app>',
  sendEmail: async (msg: { to: string; subject: string; html: string; text: string }) => {
    sent.push(msg);
  },
}));


const BASE = {
  reference: 'ORD-7K2M9QX4',
  currency: 'USD',
  subtotalMinor: 7448,
  discountMinor: 1117,
  shippingMinor: 0,
  taxMinor: 0,
  totalMinor: 6331,
  items: [
    { title: 'Wandering Stars', contributor: 'Tommy Orange', quantity: 1, lineTotalMinor: 2899 },
    { title: 'The River is Waiting', contributor: 'Wally Lamb', quantity: 2, lineTotalMinor: 4549 },
  ],
  shippingLines: ['Ama Boateng', '19 H P Nyemitei St', 'Accra', 'GH'],
  trackingCode: '7K2M9QX4',
  accessToken: null as string | null,
};

beforeEach(() => {
  sent.length = 0;
});

/**
 * This email is the only durable copy a guest ever gets of the credential that
 * reaches their order. Before it existed, closing the checkout tab made a paid
 * order permanently unreachable to the person who paid for it.
 */
describe('order confirmation email', () => {
  it('carries the order number in the subject, so an inbox search finds it', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', BASE);
    expect(sent[0].subject).toContain('ORD-7K2M9QX4');
  });

  it('lists every book with its author and quantity', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', BASE);
    for (const part of ['Wandering Stars', 'Tommy Orange', 'The River is Waiting', 'Wally Lamb']) {
      expect(sent[0].html).toContain(part);
      expect(sent[0].text).toContain(part);
    }
  });

  it('shows totals that reconcile', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', BASE);
    const { html } = sent[0];
    expect(html).toContain('74.48 USD'); // subtotal
    expect(html).toContain('-11.17 USD'); // discount, signed
    expect(html).toContain('63.31 USD'); // total
    expect(BASE.subtotalMinor - BASE.discountMinor + BASE.shippingMinor + BASE.taxMinor).toBe(
      BASE.totalMinor,
    );
  });

  it('omits the discount line entirely when there was no discount', async () => {
    // "Discount 0.00" on every full-price order invites "why didn't I get one?"
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', { ...BASE, discountMinor: 0 });
    expect(sent[0].html).not.toContain('First order discount');
    expect(sent[0].text).not.toContain('First order discount');
  });

  it('says Free rather than 0.00 when shipping is free', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', BASE);
    expect(sent[0].html).toContain('Free');
  });

  describe('the short tracking code', () => {
    it('is printed for everyone, guest or not, in both html and text', async () => {
      await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', { ...BASE, accessToken: null });
      expect(sent[0].html).toContain('7K2M9QX4');
      expect(sent[0].text).toContain('7K2M9QX4');
    });

    it('tells the reader the email address is the other half', async () => {
      // A code with no second factor named reads like a password, and someone
      // will treat it like one. The pairing has to be stated where it is shown.
      await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', BASE);
      expect(sent[0].html).toContain('email address you ordered with');
      expect(sent[0].text).toContain('email address you ordered with');
    });
  });

  describe('the guest access token', () => {
    it('is printed for a guest, in both html and text', async () => {
      const token = 'v4Xk9aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX';
      await sendOrderConfirmedEmail('a@kinkane.app', null, { ...BASE, accessToken: token });
      expect(sent[0].html).toContain(token);
      expect(sent[0].text).toContain(token);
    });

    it('never appears inside a URL', async () => {
      // checkout.service is explicit: never put this in a URL. A token in a link
      // leaks through Referer headers, browser history and page analytics.
      const token = 'v4Xk9aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX';
      await sendOrderConfirmedEmail('a@kinkane.app', null, { ...BASE, accessToken: token });
      const urls = sent[0].html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      for (const url of urls) expect(url).not.toContain(token);
      expect(sent[0].text).not.toMatch(new RegExp(`https?://[^\\s]*${token}`));
    });

    it('is absent for a signed-in buyer, who has order history instead', async () => {
      await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', { ...BASE, accessToken: null });
      expect(sent[0].html).toContain('My Account');
      expect(sent[0].html).not.toContain('attaches the order to an account');
    });
  });

  it('escapes a book title that contains markup', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', 'Ama', {
      ...BASE,
      items: [{ title: '<script>alert(1)</script>', contributor: null, quantity: 1, lineTotalMinor: 100 }],
    });
    expect(sent[0].html).not.toContain('<script>alert(1)</script>');
    expect(sent[0].html).toContain('&lt;script&gt;');
  });

  it('greets a guest who gave no name without saying "Hi null"', async () => {
    await sendOrderConfirmedEmail('a@kinkane.app', null, BASE);
    expect(sent[0].text).toContain('Hi there');
    expect(sent[0].text).not.toContain('null');
  });
});
