import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * A referral code at signup: blank means "no referral" and the account is
 * created; anything else must be a real, active code or the signup is refused
 * with "Invalid referral code." — on both the email and the social path.
 *
 * The one exception is a code parked on the guest session by an invite link.
 * The person never saw it and can't clear it, so a bad one is still ignored.
 */

const { referrals, parked } = vi.hoisted(() => ({
  referrals: { resolveCode: vi.fn() },
  parked: { code: null as string | null },
}));

vi.mock('../services/referrals.service', () => ({ referralsService: referrals }));
vi.mock('../lib/firebase', () => ({ admin: {} }));
vi.mock('../services/geo.service', () => ({ geoService: { resolveFromRequest: vi.fn(async () => ({})) } }));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ referralCode: parked.code }] }) }) }),
  },
}));

import { resolveReferralCode } from '../services/auth.service';
import * as authServiceModule from '../services/auth.service';
import { authController } from '../controllers/auth.controller';

const SESSION = 'f1e2d3c4-b5a6-4978-8b0c-1d2e3f4a5b6c';

describe('resolveReferralCode', () => {
  beforeEach(() => {
    referrals.resolveCode.mockReset();
    parked.code = null;
  });

  it('accepts an active code', async () => {
    referrals.resolveCode.mockResolvedValue({ id: 1, userId: 9 });
    await expect(resolveReferralCode('k7m2qx', undefined)).resolves.toBe('k7m2qx');
  });

  it.each([
    ['unknown or deactivated', 'K7M2QX'],
    ['too short', 'AB12'],
    ['punctuation', 'AB!2QX'],
  ])('rejects a code that is %s', async (_label, code) => {
    referrals.resolveCode.mockResolvedValue(null);
    await expect(resolveReferralCode(code, undefined)).rejects.toMatchObject({
      message: 'Invalid referral code.',
      statusCode: 400,
      code: 'INVALID_REFERRAL_CODE',
    });
  });

  it('does not look up a malformed code', async () => {
    await expect(resolveReferralCode('AB!2QX', undefined)).rejects.toThrow();
    expect(referrals.resolveCode).not.toHaveBeenCalled();
  });

  it('passes a parked guest-session code through unchecked', async () => {
    // attributeSignup drops it later if it doesn't exist; it must not block signup.
    parked.code = 'NOSUCHCODE';
    await expect(resolveReferralCode(undefined, SESSION)).resolves.toBe('NOSUCHCODE');
    expect(referrals.resolveCode).not.toHaveBeenCalled();
  });

  it('is undefined with no code anywhere', async () => {
    await expect(resolveReferralCode(undefined, undefined)).resolves.toBeUndefined();
  });
});

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const SIGNUP = { name: 'Ama', email: 'ama@example.com', password: 'Correct-Horse9' };

describe.each([
  ['signup', () => authController.signup, SIGNUP, 'signup'],
  ['social sign-in', () => authController.socialLogin, { idToken: 'tok' }, 'socialLogin'],
] as const)('%s', (_label, handler, base, method) => {
  let captured: { referralCode?: string } | undefined;

  beforeEach(() => {
    captured = undefined;
    const ok = { user: { id: 1 }, tokens: { accessToken: 'a', refreshToken: 'r' }, isNewUser: true };
    const impl = async (...args: unknown[]) => {
      captured = args[args.length - 1] as { referralCode?: string };
      return ok;
    };
    vi.spyOn(authServiceModule.authService, method).mockImplementation(impl as never);
  });

  async function call(extra: Record<string, unknown>) {
    const res = fakeRes();
    await handler()({ body: { ...base, ...extra } } as Request, res as unknown as Response);
    return res;
  }

  it.each([
    ['no key', {}],
    ['an empty string', { referralCode: '' }],
    ['whitespace', { referralCode: '   ' }],
    ['null', { referralCode: null }],
  ])('signs up with %s as no referral', async (_l, extra) => {
    const res = await call(extra);
    expect(res.statusCode).toBe(201);
    expect(captured?.referralCode).toBeUndefined();
  });

  it('passes a code through trimmed for the service to check', async () => {
    await call({ referralCode: '  K7M2QX ' });
    expect(captured?.referralCode).toBe('K7M2QX');
  });

  it('answers a wrong code with the plain message and a code', async () => {
    vi.spyOn(authServiceModule.authService, method).mockRejectedValue(
      Object.assign(new Error('Invalid referral code.'), { statusCode: 400, code: 'INVALID_REFERRAL_CODE' }),
    );
    const res = await call({ referralCode: 'NOSUCHCODE' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid referral code.', code: 'INVALID_REFERRAL_CODE' });
  });

  it('rejects a non-string code with the same message', async () => {
    const res = await call({ referralCode: 123456 });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { referralCode: ['Invalid referral code.'] } });
  });
});
