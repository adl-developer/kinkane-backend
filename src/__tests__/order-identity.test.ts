import { describe, it, expect } from 'vitest';
import {
  generateOrderReference,
  generateAccessToken,
  generateTrackingCode,
  normalizeReference,
  hashToken,
  tokensMatch,
} from '../lib/order-identity';
import { ORDER_STATUS_BUCKET, statusesInBucket } from '../services/commerce/orders.service';

// These back the only endpoints that can be reached without an account, so the
// properties below are the access control, not a formatting concern.

describe('generateOrderReference', () => {
  it('matches the shape the API validates', () => {
    // Same pattern guestOrderSchema enforces — a generated reference the
    // endpoint would reject is a broken order.
    const pattern = /^ORD-[0-9A-HJKMNP-TV-Z]{8}$/;
    for (let i = 0; i < 500; i++) expect(generateOrderReference()).toMatch(pattern);
  });

  it('omits the characters that get misread aloud or retyped', () => {
    const refs = Array.from({ length: 500 }, () => generateOrderReference().slice(4)).join('');
    for (const forbidden of ['I', 'L', 'O', 'U']) expect(refs).not.toContain(forbidden);
  });

  it('is not sequential — the order book cannot be walked', () => {
    const seen = new Set(Array.from({ length: 2000 }, generateOrderReference));
    // Collisions are possible in principle (~40 bits) but at this sample size
    // any real duplicate means the generator is not random at all.
    expect(seen.size).toBe(2000);
  });

  it('does not bias early characters', () => {
    // 256 is an exact multiple of the 32-symbol alphabet, so byte % 32 is
    // uniform. An alphabet whose length did not divide 256 would over-represent
    // its first symbols — this catches someone "tidying" the alphabet later.
    const counts = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      const c = generateOrderReference()[4];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const expected = 20000 / 32;
    for (const n of counts.values()) expect(Math.abs(n - expected)).toBeLessThan(expected * 0.35);
  });
});

// The tracking code is no longer customer-facing — nothing accepts it and no
// email prints it — but the column is still NOT NULL UNIQUE, so checkout still
// has to produce a well-formed, non-colliding value for every order.
describe('generateTrackingCode', () => {
  it('fits the column and its alphabet', () => {
    for (let i = 0; i < 500; i++) expect(generateTrackingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('is not sequential — codes cannot be walked', () => {
    const seen = new Set(Array.from({ length: 2000 }, generateTrackingCode));
    expect(seen.size).toBe(2000);
  });
});

describe('normalizeReference', () => {
  it('accepts what a customer actually types', () => {
    // Lower case off a phone screen, the prefix left off, spaces from a
    // copy-paste. Rejecting any of these is a support ticket.
    for (const typed of ['ord-7k2m9qx4', 'ORD-7K2M-9QX4', ' ord 7k2m 9qx4 ', '7k2m9qx4']) {
      expect(normalizeReference(typed)).toBe('ORD-7K2M9QX4');
    }
  });

  it('leaves an already-clean reference alone', () => {
    expect(normalizeReference('ORD-7K2M9QX4')).toBe('ORD-7K2M9QX4');
  });

  it('cannot eat the start of a real reference when it strips the prefix', () => {
    // O is absent from the alphabet, so no generated body can begin with ORD
    // and the strip is unambiguous. If someone ever "tidies" the alphabet back
    // to full base32, this is the test that fails.
    for (let i = 0; i < 500; i++) {
      const ref = generateOrderReference();
      expect(normalizeReference(ref)).toBe(ref);
      expect(normalizeReference(ref.slice(4))).toBe(ref);
    }
  });
});

describe('the track endpoint\'s order number validation', () => {
  // Kept in sync with trackOrderSchema in orders.controller.ts. Duplicated
  // rather than imported so this stays a pure schema test, but the rule is the
  // point: normalise first, then require ORD- plus exactly eight alphabet
  // characters.
  const accepts = (input: string) => /^ORD-[0-9A-HJKMNP-TV-Z]{8}$/.test(normalizeReference(input));

  it('accepts every generated reference', () => {
    for (let i = 0; i < 200; i++) expect(accepts(generateOrderReference())).toBe(true);
  });

  it('accepts the punctuation and the missing prefix a customer arrives with', () => {
    for (const typed of ['ord-7k2m9qx4', 'ORD-7K2M-9QX4', 'ORD 7K2M 9QX4', '7k2m9qx4']) {
      expect(accepts(typed)).toBe(true);
    }
  });

  it('rejects a string that is only separators', () => {
    // The reason the input is normalised before validation rather than after: a
    // pattern loose enough to allow the dashes above would wave this through to
    // a database lookup for the single character "7".
    expect(accepts('ORD-7-------')).toBe(false);
    expect(accepts('--------')).toBe(false);
  });

  it('rejects the wrong length and the excluded characters', () => {
    for (const bad of ['ORD-7K2M9QX', 'ORD-7K2M9QX45', 'ORD-7K2M9QXO', '7K2M9QXI']) {
      expect(accepts(bad)).toBe(false);
    }
  });
});

describe('generateAccessToken', () => {
  it('matches the shape the API validates', () => {
    for (let i = 0; i < 200; i++) expect(generateAccessToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('carries 256 bits — brute force is not a threat model', () => {
    expect(Buffer.from(generateAccessToken(), 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    expect(new Set(Array.from({ length: 2000 }, generateAccessToken)).size).toBe(2000);
  });
});

describe('tokensMatch', () => {
  it('accepts a hash against itself', () => {
    const h = hashToken(generateAccessToken());
    expect(tokensMatch(h, h)).toBe(true);
  });

  it('rejects a different token', () => {
    expect(tokensMatch(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('rejects empty and mismatched lengths instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; a throw here would surface as
    // a 500 on an unauthenticated endpoint and distinguish malformed input
    // from a wrong guess.
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch('aa', hashToken('b'))).toBe(false);
    expect(() => tokensMatch('zz', 'zz')).not.toThrow();
  });

  it('hashes deterministically, so lookup by hash finds the row', () => {
    const token = generateAccessToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toHaveLength(64);
  });
});

describe('order status buckets', () => {
  it('never files an incomplete checkout as a real order', () => {
    // These three are what a customer abandoned, not what they bought. If any
    // of them ever bucketed as in_progress they would appear in order history.
    expect(ORDER_STATUS_BUCKET.pending_payment).toBe('pending');
    expect(ORDER_STATUS_BUCKET.payment_failed).toBe('closed');
    expect(ORDER_STATUS_BUCKET.expired).toBe('closed');
  });

  it('treats everything between payment and delivery as in progress', () => {
    for (const status of ['paid', 'submitted_to_supplier', 'acknowledged', 'dispatched'] as const) {
      expect(ORDER_STATUS_BUCKET[status]).toBe('in_progress');
    }
  });

  it('separates delivered from dispatched', () => {
    // "Left the warehouse" is not "arrived" — the whole reason the delivered
    // status was added.
    expect(ORDER_STATUS_BUCKET.dispatched).toBe('in_progress');
    expect(ORDER_STATUS_BUCKET.delivered).toBe('delivered');
  });

  it('closes anything that ended badly', () => {
    for (const status of ['supplier_rejected', 'refunded', 'cancelled'] as const) {
      expect(ORDER_STATUS_BUCKET[status]).toBe('closed');
    }
  });

  it('inverts consistently', () => {
    expect(statusesInBucket('delivered')).toEqual(['delivered']);
    expect(statusesInBucket('in_progress')).toContain('paid');
    expect(statusesInBucket('in_progress')).not.toContain('refunded');
  });
});
