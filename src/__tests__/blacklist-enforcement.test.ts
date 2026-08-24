import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A blacklist that blocks one way in and not the others is decoration.
 *
 * The first version guarded the password login only, so a blacklisted customer
 * kept their session alive indefinitely: their client traded its refresh token
 * for a fresh pair on a timer and never needed to log in again. "Continue with
 * Google" walked straight past it too.
 *
 * These assert the guard's *presence* at each entry point by reading the source.
 * Crude, but the alternative is a live database and a Firebase token, and the
 * property worth protecting is "nobody added a fourth way in without gating it"
 * — which is a question about the code, not about one request.
 */

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

/** Body of a named method, up to the next method at the same indentation. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `could not find "${signature}" — did it get renamed?`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n  },\n');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('blacklist enforcement', () => {
  const auth = read('services/auth.service.ts');

  it('blocks the password login', () => {
    expect(methodBody(auth, 'async login(')).toContain('assertNotBlacklisted');
  });

  it('blocks refreshing a session', () => {
    // Without this the block never bites anyone already signed in.
    expect(methodBody(auth, 'async refresh(')).toContain('assertNotBlacklisted');
  });

  it('blocks social sign-in, on both the returning and the account-linking path', () => {
    const social = methodBody(auth, 'async socialLogin(');
    const guards = social.match(/assertNotBlacklisted/g) ?? [];
    // One for the known-provider path, one for linking a provider to an
    // existing account by email.
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks checkout, separately from login', () => {
    // An access token minted before the blacklist stays valid until it expires,
    // so the money path carries its own check rather than trusting the session.
    const checkout = read('services/commerce/checkout.service.ts');
    expect(checkout).toContain('blacklistedAt');
    expect(checkout).toContain('ACCOUNT_SUSPENDED');
  });

  it('revokes live sessions when the blacklist is applied', () => {
    // Belt and braces with the refresh guard: this ends the session now rather
    // than at its next refresh.
    const customers = read('services/admin/customers.service.ts');
    expect(customers).toContain('refreshTokens');
    expect(customers).toContain('sessionsRevoked');
  });

  it('does not leak the blacklist flag back to the client', () => {
    // socialLogin selects the column to check it, and must strip it before the
    // user object goes out.
    expect(auth).toContain('const { blacklistedAt: _blacklistedAt, ...safeUser } = user;');
  });
});
