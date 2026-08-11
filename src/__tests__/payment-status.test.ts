import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusFromSession, generateReference } from '../services/payments.service';

// This mapping decides whether a user is told their money went through. Being
// wrong is expensive in both directions — a false "succeeded" hands over goods
// for money that never arrived, a false "failed" makes a paying customer think
// they were declined — and neither shows up in a happy-path test, because the
// happy path is the one case that is obvious.

describe('statusFromSession', () => {
  it('succeeds only when the session is complete AND paid', () => {
    expect(statusFromSession({ status: 'complete', payment_status: 'paid' })).toBe('succeeded');
  });

  it('treats a complete-but-unpaid session as still pending, not paid', () => {
    // The case that matters most. Stripe splits this across two fields: `status`
    // describes the session, `payment_status` describes the money. A delayed
    // settlement method completes the session while the funds are still in
    // flight — reading `status: 'complete'` alone would hand over a subscription
    // for money that has not arrived and may never.
    expect(statusFromSession({ status: 'complete', payment_status: 'unpaid' })).toBe('pending');
  });

  it('succeeds when nothing was owed', () => {
    // 100% discount codes and trial-only sessions complete with
    // no_payment_required. Legitimately successful with zero charged, and
    // reporting it as pending would strand the user on a spinner forever.
    expect(statusFromSession({ status: 'complete', payment_status: 'no_payment_required' })).toBe(
      'succeeded',
    );
  });

  it('reports an expired session as expired', () => {
    expect(statusFromSession({ status: 'expired', payment_status: 'unpaid' })).toBe('expired');
  });

  it('reports an open session as pending, not failed', () => {
    // The user is still on the Stripe page, or wandered off without the session
    // expiring. Not a failure — telling them the payment failed while they are
    // mid-checkout would be actively wrong.
    expect(statusFromSession({ status: 'open', payment_status: 'unpaid' })).toBe('pending');
  });

  it('never invents a status from missing fields', () => {
    // A malformed or partial session object must fall back to pending rather
    // than to either terminal answer.
    expect(statusFromSession({})).toBe('pending');
    expect(statusFromSession({ status: null, payment_status: null })).toBe('pending');
  });

  it('is never "succeeded" unless the session is complete', () => {
    // Guards the branch order: no combination of payment_status on a
    // non-complete session may report success.
    for (const status of ['open', 'expired', null, undefined, 'weird']) {
      for (const payment of ['paid', 'unpaid', 'no_payment_required', null]) {
        expect(statusFromSession({ status, payment_status: payment })).not.toBe('succeeded');
      }
    }
  });
});

describe('generateReference', () => {
  it('is prefixed so it is recognisable in a support conversation', () => {
    expect(generateReference()).toMatch(/^KP-[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it('omits the characters people misread when reading a reference aloud', () => {
    // I, L, O and U are absent from the alphabet — a payment reference gets read
    // down a phone line more often than almost anything else in the system.
    const refs = Array.from({ length: 300 }, () => generateReference().slice(3));
    expect(refs.join('')).not.toMatch(/[ILOU]/);
  });

  it('does not collide across a large sample', () => {
    const refs = new Set(Array.from({ length: 5000 }, () => generateReference()));
    expect(refs.size).toBe(5000);
  });
});

/**
 * Wiring checks, not logic checks.
 *
 * The status mapping above is only useful if both checkout flows actually mint
 * a reference and both webhook paths actually settle one. Those are one-line
 * call sites that are easy to add on one side and forget on the other — which
 * is precisely what happened here: the subscription flow was wired first and
 * the book-order flow was not. A grep-level assertion is crude, but it fails
 * loudly the next time someone adds a third payment flow and wires only half of
 * it.
 */
describe('both checkout flows mint a reference', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

  it('subscription checkout returns a paymentReference', () => {
    const src = read('services/subscriptions/checkout.service.ts');
    expect(src).toMatch(/paymentsService\.create\(/);
    expect(src).toMatch(/kind: 'subscription'/);
    expect(src).toMatch(/paymentReference: payment\.reference/);
  });

  it('book-order checkout returns a paymentReference', () => {
    const src = read('services/commerce/checkout.service.ts');
    expect(src).toMatch(/paymentsService\.create\(/);
    expect(src).toMatch(/kind: 'order'/);
    expect(src).toMatch(/paymentReference: payment\.reference/);
  });

  // Without this the confirm response cannot point the app back at what it
  // bought, and the client has to correlate by timing.
  it('carries the order id onto the payment row', () => {
    expect(read('services/commerce/checkout.service.ts')).toMatch(/orderId: order\.id/);
  });
});

describe('webhooks settle the reference', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

  it('settles a completed subscription session', () => {
    expect(read('services/subscriptions/webhooks.service.ts')).toMatch(
      /markFromSession\(session\.id, 'succeeded'\)/,
    );
  });

  it('settles a completed order session', () => {
    expect(read('services/commerce/order-webhooks.service.ts')).toMatch(
      /markFromSession\(session\.id, 'succeeded'\)/,
    );
  });

  it('settles an expired session for either kind', () => {
    expect(read('services/subscriptions/webhooks.service.ts')).toMatch(
      /markFromSession\(\s*expired\.id,\s*'expired'/,
    );
  });
});
