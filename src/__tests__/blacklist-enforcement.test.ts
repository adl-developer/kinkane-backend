import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A blacklist that blocks one way in and not the others is decoration.
 *
 * A blacklisted account cannot sign in by any method, cannot buy — signed in or
 * as a guest under the same address — and is refused by every community route
 * for whatever is left of the access token it already holds.
 *
 * These assert each guard's *presence* by reading the source. Crude, but the
 * property worth protecting is "nobody added another way in without gating
 * it", which is a question about the code rather than about one request. The
 * behaviour itself is covered by blacklisted-account.integration.test.ts.
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
    expect((social.match(/assertNotBlacklisted/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('blocks checkout, signed in and as a guest under the same address', () => {
    // An access token minted before the blacklist stays valid until it expires,
    // so the money path carries its own check rather than trusting the session.
    const checkout = read('services/commerce/checkout.service.ts');
    expect(checkout).toContain('if (user.blacklistedAt !== null)');
    // Lowercasing the typed address, not the column, keeps it on the email index.
    expect(checkout).toContain('eq(users.email, contactEmail.trim().toLowerCase())');
    // …and start() actually calls it, after settling the contact address.
    expect(methodBody(checkout, 'async start(')).toContain('await assertEmailNotBlacklisted(contactEmail);');
  });

  it('revokes live sessions when the blacklist is applied', () => {
    const customers = read('services/admin/customers.service.ts');
    expect(customers).toContain('refreshTokens');
    expect(customers).toContain('sessionsRevoked');
  });

  it('guards every community router, after authentication', () => {
    // Covers the access token still in hand when the blacklist lands.
    for (const router of ['community', 'groups', 'users', 'reports']) {
      const source = read(`routes/${router}.routes.ts`);
      const authAt = source.indexOf('router.use(requireAuth);');
      const guardAt = source.indexOf('router.use(requireCommunityAccess);');
      expect(guardAt, `${router}.routes.ts is missing the community guard`).toBeGreaterThan(authAt);
    }
    expect(read('routes/mentions.routes.ts')).toContain('requireAuth, requireCommunityAccess');
  });

  it('does not leak the blacklist flag back to the client', () => {
    expect(auth).toContain('const { blacklistedAt: _blacklistedAt, ...safeUser } = user;');
  });
});
