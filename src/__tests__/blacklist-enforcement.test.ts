import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A blacklist shuts an account out of the community and nowhere else: they can
 * still sign in, browse and buy books. That is what the email promises them,
 * so it is what the code has to do.
 *
 * The community half is only as good as its coverage — a router that forgets
 * the guard is a way back in. These assert the guard's *presence* on every
 * community router, and its *absence* from sign-in and checkout, by reading the
 * source. Crude, but the property worth protecting is "nobody added a social
 * router without gating it, or re-gated the bookstore", which is a question
 * about the code rather than about one request. The behaviour itself is
 * covered by blacklisted-account.integration.test.ts.
 */

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('blacklist enforcement', () => {
  it('guards every community router, after authentication', () => {
    for (const router of ['community', 'groups', 'users', 'reports']) {
      const source = read(`routes/${router}.routes.ts`);
      const auth = source.indexOf('router.use(requireAuth);');
      const guard = source.indexOf('router.use(requireCommunityAccess);');
      expect(guard, `${router}.routes.ts is missing the community guard`).toBeGreaterThan(-1);
      expect(guard, `${router}.routes.ts guards before authenticating`).toBeGreaterThan(auth);
    }
    expect(read('routes/mentions.routes.ts')).toContain('requireAuth, requireCommunityAccess');
  });

  it('still lets a blacklisted account sign in, by every method', () => {
    const auth = read('services/auth.service.ts');
    expect(auth).not.toContain('assertNotBlacklisted');
    expect(auth).not.toContain('ACCOUNT_SUSPENDED');
  });

  it('still lets a blacklisted account buy books', () => {
    const checkout = read('services/commerce/checkout.service.ts');
    expect(checkout).not.toContain('ACCOUNT_SUSPENDED');
  });

  it('does not end their sessions when the blacklist is applied', () => {
    // They are meant to stay signed in to the bookstore; the community guard
    // reads the flag on every request, so nothing waits on a session ending.
    expect(read('services/admin/customers.service.ts')).not.toContain('refreshTokens');
  });
});
