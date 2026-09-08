import { describe, it, expect } from 'vitest';
import { resolveBuyerContact } from '../services/commerce/checkout.service';

/**
 * The web shop signs a browser up silently on first add-to-cart, so a buyer who
 * has never made an account still arrives at checkout holding a token for a
 * real row — one whose email is a `guest-<uuid>@guest.kinkane.app` placeholder
 * with no inbox.
 *
 * Treating that row as a signed-in buyer wrote the placeholder onto the order,
 * which meant: the confirmation email was addressed to a void, the Stripe
 * customer was filed under an address the buyer had never seen, the tracking
 * lookup demanded an email nobody could know, and the first-order discount
 * keyed on a value unique to the browser rather than the person.
 *
 * These are the guards on that not coming back.
 */

const GUEST = { email: 'guest-a59cc16a-808e-42c1-9afd@guest.kinkane.app', isGuest: true };
const REAL = { email: 'rachel@example.com', isGuest: false };

describe('resolveBuyerContact', () => {
  it('uses the typed address for a guest account, never the placeholder', () => {
    expect(
      resolveBuyerContact({ account: GUEST, contactEmail: 'rachel@example.com' }),
    ).toEqual({ contactEmail: 'rachel@example.com', isGuestBuyer: true });
  });

  it('refuses a guest-account checkout with no address rather than falling back', () => {
    // The fallback is the bug. An order nobody can be reached at is worse than
    // a 400 the client can correct.
    expect(() => resolveBuyerContact({ account: GUEST })).toThrowError(/email address is required/i);
    expect(() => resolveBuyerContact({ account: GUEST, contactEmail: '' })).toThrowError(
      /email address is required/i,
    );
  });

  it('gives that refusal the code the client already handles', () => {
    try {
      resolveBuyerContact({ account: GUEST });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
      expect((err as { code: string }).code).toBe('EMAIL_REQUIRED');
    }
  });

  it('still ignores the body for a real signed-in buyer', () => {
    // The rule this bug lived under is correct and stays: otherwise checkout is
    // a way to post someone else's receipt wherever you like.
    expect(
      resolveBuyerContact({ account: REAL, contactEmail: 'attacker@example.com' }),
    ).toEqual({ contactEmail: 'rachel@example.com', isGuestBuyer: false });
  });

  it('treats no account the same as a guest account', () => {
    expect(
      resolveBuyerContact({ account: null, contactEmail: 'rachel@example.com' }),
    ).toEqual({ contactEmail: 'rachel@example.com', isGuestBuyer: true });
    expect(() => resolveBuyerContact({ account: null })).toThrowError(/email address is required/i);
  });

  it('decides on the is_guest column, not the shape of the address', () => {
    // The domain is a convention the frontend owns; a check that pattern-matched
    // it here would break the day that host is renamed. See db/schema/users.
    expect(
      resolveBuyerContact({
        account: { email: 'guest-abc@guest.kinkane.app', isGuest: false },
        contactEmail: 'typed@example.com',
      }),
    ).toEqual({ contactEmail: 'guest-abc@guest.kinkane.app', isGuestBuyer: false });
  });
});
