import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Guards on `POST /api/v1/orders/track` — the order-number lookup.
 *
 * The order number is printed on receipts, quoted in support tickets and
 * pasted into screenshots, so it is an identifier and never a credential. The
 * contact email is what makes looking up on it safe, so everything below is
 * about that pairing holding: a right order number with a wrong email must be
 * indistinguishable from no order at all, and "wrong" must mean *any* address
 * that is not the one on the order.
 */

// ── Database double ──────────────────────────────────────────────────────────
// One table of orders keyed by reference, plus a record of what the code under
// test actually asked for.
let ordersByReference: Record<string, Record<string, unknown>> = {};
let requestedReference: string | undefined;

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ __op: 'eq', column, value }),
  };
});

vi.mock('../db', () => {
  const selectChain = () => {
    let rows: unknown[] = [];
    const chain = {
      from: (table: { toString?: () => string }) => {
        // Only the orders lookup is interesting; the items read that follows
        // returns nothing, which toView renders as an empty basket.
        rows = [];
        void table;
        return chain;
      },
      where: (pred: { __op: string; value: unknown }) => {
        if (pred?.__op === 'eq' && typeof pred.value === 'string') {
          requestedReference = pred.value;
          const found = ordersByReference[pred.value];
          rows = found ? [found] : [];
        }
        return chain;
      },
      limit: async () => rows,
      then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
    };
    return chain;
  };

  return { db: { select: () => selectChain() } };
});

// After the mocks: vi.mock is hoisted, so the service imported here is built
// against the doubles above.
import { ordersService } from '../services/commerce/orders.service';

/** Enough of an order row for toView to render one. */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1042,
    reference: 'ORD-7K2M9QX4',
    trackingCode: '7K2M9QX4',
    contactEmail: 'Rachel@Example.com',
    status: 'paid',
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    dispatchedAt: null,
    deliveredAt: null,
    presentmentCurrency: 'GBP',
    subtotalMinor: 1299,
    discountMinor: 0,
    discountReason: null,
    shippingMinor: 0,
    taxMinor: 0,
    totalMinor: 1299,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    paidAt: new Date('2026-09-01T10:00:05Z'),
    shippingCountryCode: 'GB',
    contactPhone: null,
    ...overrides,
  };
}

beforeEach(() => {
  ordersByReference = { 'ORD-7K2M9QX4': orderRow() };
  requestedReference = undefined;
});

describe('findByReferenceAndEmail', () => {
  it('returns the order when the order number and email both match', async () => {
    const order = await ordersService.findByReferenceAndEmail('ORD-7K2M9QX4', 'Rachel@Example.com');
    expect(order?.reference).toBe('ORD-7K2M9QX4');
  });

  it('matches the email case-insensitively and ignores surrounding space', async () => {
    // The address is typed by hand on this form. Case and a trailing space from
    // a paste are not the customer getting it wrong.
    for (const typed of ['rachel@example.com', 'RACHEL@EXAMPLE.COM', ' Rachel@Example.com ']) {
      expect(await ordersService.findByReferenceAndEmail('ORD-7K2M9QX4', typed)).not.toBeNull();
    }
  });

  it('normalizes the order number the customer typed before looking it up', async () => {
    await ordersService.findByReferenceAndEmail(' ord-7k2m 9qx4 ', 'rachel@example.com');
    expect(requestedReference).toBe('ORD-7K2M9QX4');
  });

  it('finds the order when the customer omits the ORD- prefix', async () => {
    // The prefix is on every order, so it carries no information and is the
    // easiest part to leave out when reading a number off a screen.
    const order = await ordersService.findByReferenceAndEmail('7k2m9qx4', 'rachel@example.com');
    expect(order?.reference).toBe('ORD-7K2M9QX4');
  });

  it('refuses a correct order number with the wrong email', async () => {
    // The whole security property. If this ever returns an order, the order
    // number alone is the credential — and it is printed on the receipt.
    expect(
      await ordersService.findByReferenceAndEmail('ORD-7K2M9QX4', 'someone-else@example.com'),
    ).toBeNull();
  });

  it('does not treat a +tag or a dotted gmail as the same address', async () => {
    // normalizeEmailForPromotions deliberately collapses these so one person
    // cannot claim two first-order discounts. Reusing it here would mean
    // `rachel+anything@` opened Rachel's order — the exact reason that helper
    // documents itself as unsafe for authentication.
    ordersByReference['ORD-7K2M9QX4'] = orderRow({ contactEmail: 'rachel@gmail.com' });
    for (const near of ['rachel+shop@gmail.com', 'r.a.c.h.e.l@gmail.com']) {
      expect(await ordersService.findByReferenceAndEmail('ORD-7K2M9QX4', near)).toBeNull();
    }
  });

  it('returns null for an unknown order number, exactly as for a wrong email', async () => {
    // Same value out of both paths, so the endpoint cannot be used to discover
    // which orders exist.
    const unknown = await ordersService.findByReferenceAndEmail('ORD-ZZZZZZZZ', 'rachel@example.com');
    const wrongEmail = await ordersService.findByReferenceAndEmail('ORD-7K2M9QX4', 'nope@example.com');
    expect(unknown).toBeNull();
    expect(wrongEmail).toBeNull();
  });
});
