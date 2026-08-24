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

  it('collects failure states under needs_attention rather than dropping them', () => {
    // supplier_rejected is the whole reason this tab exists — a customer paid
    // and the supplier will not fulfil.
    expect(tabForStatus('supplier_rejected')).toBe('needs_attention');
    expect(tabForStatus('payment_failed')).toBe('needs_attention');
    expect(tabForStatus('refunded')).toBe('needs_attention');
    expect(tabForStatus('cancelled')).toBe('needs_attention');
  });

  it('treats never-paid orders as pending, in no tab', () => {
    expect(tabForStatus('pending_payment')).toBe('pending');
    expect(tabForStatus('expired')).toBe('pending');
  });

  it('accounts for every status the schema can produce', () => {
    // If a new order status is added, this fails until the mapping covers it —
    // which is the point. An unmapped status silently becomes 'pending'.
    const allStatuses = Object.keys(ORDER_STATUS_BUCKET);
    const mapped = new Set<string>([
      ...Object.values(ADMIN_ORDER_TABS).flat(),
      'pending_payment',
      'expired',
    ]);
    for (const status of allStatuses) {
      expect(mapped.has(status), `status "${status}" is not in any admin tab or the pending set`).toBe(true);
    }
  });
});
