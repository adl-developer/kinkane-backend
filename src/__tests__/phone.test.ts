import { describe, it, expect } from 'vitest';
import { normalizePhone, phoneSchema } from '../lib/phone';

// The number collected at checkout is handed to a courier as an SMS contact, so
// "stored as typed" is not good enough — one phone has to be one string.

describe('normalizePhone', () => {
  it('keeps a number that is already E.164', () => {
    expect(normalizePhone('+233201234567')).toBe('+233201234567');
  });

  it('strips the spacing a human types', () => {
    // The formats in the checkout designs, verbatim.
    expect(normalizePhone('+233 20 123 4567')).toBe('+233201234567');
    expect(normalizePhone('+233534529665')).toBe('+233534529665');
    expect(normalizePhone('+44 (0)20 7946-0958')).toBe('+4402079460958');
  });

  it('converts the 00 international prefix to +', () => {
    expect(normalizePhone('00233201234567')).toBe('+233201234567');
    expect(normalizePhone('00 233 20 123 4567')).toBe('+233201234567');
  });

  it('refuses a bare national number rather than guessing the country', () => {
    // Guessing from the shipping address would produce a plausible, wrong,
    // undialable number — worse than making the buyer type their country code.
    expect(normalizePhone('020 123 4567')).toBeNull();
    expect(normalizePhone('0201234567')).toBeNull();
  });

  it('refuses malformed input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('+')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
    expect(normalizePhone('+233 20 CALL ME')).toBeNull();
    // A country code cannot start with zero.
    expect(normalizePhone('+0233201234567')).toBeNull();
  });

  it('enforces the E.164 length bounds', () => {
    expect(normalizePhone('+1234567')).toBeNull(); // 7 digits — a fragment
    expect(normalizePhone('+12345678')).toBe('+12345678'); // 8 — the floor
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345'); // 15 — the ceiling
    expect(normalizePhone('+1234567890123456')).toBeNull(); // 16 — over
  });
});

describe('phoneSchema', () => {
  it('normalises on the way through, so callers never see raw input', () => {
    expect(phoneSchema.parse('+233 20 123 4567')).toBe('+233201234567');
  });

  it('fails with a message that tells the buyer what to do', () => {
    const result = phoneSchema.safeParse('020 123 4567');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('international format');
    }
  });

  it('stays within the column width it feeds', () => {
    // varchar(32) on both users.phone and orders.contact_phone. Anything the
    // schema accepts must fit, or the insert fails after validation passed.
    const longest = phoneSchema.parse('+123456789012345');
    expect(longest.length).toBeLessThanOrEqual(32);
    expect(phoneSchema.safeParse('+' + '1'.repeat(40)).success).toBe(false);
  });
});
