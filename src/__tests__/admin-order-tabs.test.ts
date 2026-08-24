import { describe, it, expect } from 'vitest';
import { ADMIN_ORDER_TABS, tabForStatus } from '../services/admin/dashboard.service';
import { ORDER_STATUS_BUCKET } from '../services/commerce/orders.service';

// The design shows three tabs and the schema has eleven statuses. The mapping is
// where an order goes to hide: a paid order the supplier rejected must not fall
// through a gap and become invisible in the only screen anyone looks at.

describe('tabForStatus', () => {
  it('routes the fulfilment lifecycle to the right tab', () => {
    expect(tabForStatus('paid')).toBe('processing');
    expect(tabForStatus('submitted_to_supplier')).toBe('processing');
    expect(tabForStatus('acknowledged')).toBe('processing');
    expect(tabForStatus('dispatched')).toBe('shipped');
    expect(tabForStatus('delivered')).toBe('delivered');
  });

  it('puts money-moved failures in needs_attention', () => {
    // supplier_rejected is the whole reason this tab exists — a customer paid
    // and the supplier will not fulfil, so we owe them a book or a refund.
    expect(tabForStatus('supplier_rejected')).toBe('needs_attention');
    expect(tabForStatus('refunded')).toBe('needs_attention');
    expect(tabForStatus('cancelled')).toBe('needs_attention');
  });

  it('puts never-charged orders in unpaid, including a declined card', () => {
    expect(tabForStatus('pending_payment')).toBe('unpaid');
    expect(tabForStatus('expired')).toBe('unpaid');
    // payment_failed used to sit in needs_attention next to supplier_rejected,
    // which made the badge meaningless: "3 need attention" could be three
    // declined cards (nothing owed) or three paid orders stuck at the supplier.
    // Same number, opposite urgency.
    expect(tabForStatus('payment_failed')).toBe('unpaid');
  });

  it('never mixes charged and uncharged orders in one tab', () => {
    // The property that makes the badges meaningful, asserted directly rather
    // than left as a comment.
    // `cancelled` counts as charged. Not obvious, but the customer-facing list
    // already settles it: ordersService.list includes `cancelled` in the set a
    // customer would "recognise as an order", alongside paid and refunded, while
    // excluding the three never-paid statuses. A cancelled order in this system
    // follows a payment.
    const moneyMoved = new Set([
      'paid', 'submitted_to_supplier', 'acknowledged', 'dispatched', 'delivered',
      'supplier_rejected', 'refunded', 'cancelled',
    ]);
    for (const [tab, statuses] of Object.entries(ADMIN_ORDER_TABS)) {
      const charged = statuses.map((s) => moneyMoved.has(s));
      expect(
        new Set(charged).size,
        `tab "${tab}" mixes charged and uncharged statuses: ${statuses.join(', ')}`,
      ).toBe(1);
    }
  });

  it('accounts for every status the schema can produce', () => {
    // If a new order status is added, this fails until the mapping covers it.
    // Without it an unmapped status falls silently into `unpaid` and quietly
    // misreports itself as a sale that never happened.
    const mapped = new Set<string>(Object.values(ADMIN_ORDER_TABS).flat());
    for (const status of Object.keys(ORDER_STATUS_BUCKET)) {
      expect(mapped.has(status), `status "${status}" is in no admin tab`).toBe(true);
    }
  });

  it('assigns each status to exactly one tab', () => {
    // Two tabs claiming the same status would double-count it in the badges.
    const seen = new Map<string, string>();
    for (const [tab, statuses] of Object.entries(ADMIN_ORDER_TABS)) {
      for (const status of statuses) {
        expect(seen.has(status), `"${status}" is in both ${seen.get(status)} and ${tab}`).toBe(false);
        seen.set(status, tab);
      }
    }
  });
});
