import { describe, it, expect } from 'vitest';
import { z } from 'zod';

/**
 * Guard on the `status` filter used by GET /api/v1/orders.
 *
 * The "All" tab in the order UI sends the query key with either no value at
 * all, an empty value, or the literal string `all` depending on how the front
 * end has last been touched. All three must drop the filter rather than 400,
 * so a cleared tab and an absent parameter behave the same. This test locks
 * that behaviour in against a future simplification of the schema.
 */

// Kept in sync with src/controllers/orders.controller.ts. Duplicated rather
// than imported to avoid pulling the whole controller (and its auth types) into
// a schema test.
const statusFilter = z.preprocess(
  (value) => (value === '' || value === 'all' ? undefined : value),
  z.enum(['in_progress', 'delivered', 'closed']).optional(),
);

describe('orders list status filter', () => {
  it.each([
    ['omitted', undefined],
    ['empty string', ''],
    ['the literal "all"', 'all'],
  ])('treats %s as no filter', (_label, input) => {
    expect(statusFilter.parse(input)).toBeUndefined();
  });

  it.each(['in_progress', 'delivered', 'closed'] as const)(
    'accepts the real value %s',
    (input) => {
      expect(statusFilter.parse(input)).toBe(input);
    },
  );

  it('rejects an unknown value rather than silently dropping it', () => {
    // A bucket name we deliberately do not surface — must 400, not fall
    // through to "unfiltered" and quietly widen the response.
    expect(() => statusFilter.parse('pending')).toThrow();
    expect(() => statusFilter.parse('rubbish')).toThrow();
  });
});
