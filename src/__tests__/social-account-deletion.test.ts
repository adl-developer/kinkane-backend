import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Deleting an account used to demand a password, which Google/Apple accounts
 * never have — so a social-only user had no way to delete their account in-app.
 * It now also accepts a fresh Firebase ID token, the same rule Change Plan and
 * group delete already use.
 *
 * What matters is that no wrong credential ever reaches Stripe or the delete:
 * a stale token, a token for someone else's Google account, and a password on
 * a passwordless account are all refused first.
 */

const { state, verifyIdToken, terminate, enqueueEmail } = vi.hoisted(() => ({
  state: {
    // Rows handed back by successive db.select() chains, in call order.
    selects: [] as unknown[][],
    deleted: [] as unknown[],
  },
  verifyIdToken: vi.fn(),
  terminate: vi.fn(async () => {}),
  enqueueEmail: vi.fn(async () => {}),
}));

vi.mock('../lib/firebase', () => ({ admin: { auth: () => ({ verifyIdToken }) } }));
vi.mock('../services/subscriptions/checkout.service', () => ({
  checkoutService: { terminateForAccountDeletion: terminate },
}));
vi.mock('../lib/email-queue', () => ({ enqueueEmail }));
vi.mock('../db', () => {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => state.selects.shift() ?? [] }) }),
  });
  const tx = { delete: (table: unknown) => ({ where: async () => { state.deleted.push(table); } }) };
  return { db: { select, transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } };
});

import { authService } from '../services/auth.service';
import { authController } from '../controllers/auth.controller';

const USER = { id: 7, name: 'Ada', email: 'ada@example.com' };
const nowSeconds = () => Math.floor(Date.now() / 1000);

function googleToken(authAgeSeconds: number) {
  return {
    uid: 'google-uid-1',
    auth_time: nowSeconds() - authAgeSeconds,
    firebase: { sign_in_provider: 'google.com' },
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

describe('account deletion for social accounts', () => {
  beforeEach(() => {
    state.selects = [];
    state.deleted = [];
    verifyIdToken.mockReset();
    terminate.mockClear();
    enqueueEmail.mockClear();
  });

  it('deletes with a fresh ID token from a linked provider', async () => {
    verifyIdToken.mockResolvedValue(googleToken(30));
    state.selects = [[USER], [{ id: 1 }]]; // the user, then the linked provider row

    await authService.deleteAccount(USER.id, { idToken: 'tok' });

    expect(terminate).toHaveBeenCalledWith(USER.id);
    expect(state.deleted).toHaveLength(2); // refresh tokens, then the user
    expect(enqueueEmail).toHaveBeenCalledWith('account-deleted', { to: USER.email, name: USER.name });
  });

  it('refuses a token from a sign-in more than 5 minutes old', async () => {
    verifyIdToken.mockResolvedValue(googleToken(10 * 60));
    state.selects = [[USER]];

    await expect(authService.deleteAccount(USER.id, { idToken: 'tok' })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(state.deleted).toHaveLength(0);
  });

  it("refuses a valid token for a Google account that isn't linked to this user", async () => {
    verifyIdToken.mockResolvedValue(googleToken(30));
    state.selects = [[USER], []]; // no matching provider row

    await expect(authService.deleteAccount(USER.id, { idToken: 'tok' })).rejects.toMatchObject({
      statusCode: 401,
      message: 'Incorrect sign-in',
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(state.deleted).toHaveLength(0);
  });

  it('refuses a token Firebase rejects', async () => {
    verifyIdToken.mockRejectedValue(new Error('bad signature'));
    state.selects = [[USER]];

    await expect(authService.deleteAccount(USER.id, { idToken: 'tok' })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(state.deleted).toHaveLength(0);
  });

  it('still refuses a password on an account that has none', async () => {
    state.selects = [[USER], [{ passwordHash: null }]];

    await expect(authService.deleteAccount(USER.id, { password: 'guess' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(state.deleted).toHaveLength(0);
  });
});

describe('DELETE /auth/account body', () => {
  it.each([
    ['neither credential', {}],
    ['both credentials', { password: 'pw', idToken: 'tok' }],
  ])('rejects %s before touching the service', async (_label, body) => {
    const spy = vi.spyOn(authService, 'deleteAccount');
    const res = fakeRes();

    await authController.deleteAccount(
      { body, user: { id: USER.id } } as unknown as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('passes an idToken through to the service', async () => {
    const spy = vi.spyOn(authService, 'deleteAccount').mockResolvedValue();
    const res = fakeRes();

    await authController.deleteAccount(
      { body: { idToken: 'tok' }, user: { id: USER.id } } as unknown as Request,
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(USER.id, { password: undefined, idToken: 'tok' });
    spy.mockRestore();
  });
});
