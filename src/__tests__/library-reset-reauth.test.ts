import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Clearing a shelf is confirmed with the password or a fresh Firebase ID token.
 * The old check only asked whether the token was fresh, not whose it was — so
 * anyone holding a stolen session could sign in with their *own* Google
 * account and wipe the victim's shelf. It now uses the shared ownership check,
 * which also requires the token's provider account to be linked to the caller.
 */

const { state, verifyIdToken, bust } = vi.hoisted(() => ({
  state: {
    // Rows handed back by successive db.select() chains, in call order.
    selects: [] as unknown[][],
    wiped: false,
  },
  verifyIdToken: vi.fn(),
  bust: vi.fn(async () => {}),
}));

vi.mock('../lib/firebase', () => ({ admin: { auth: () => ({ verifyIdToken }) } }));
vi.mock('../lib/exclusions', () => ({ bustUserExclusions: bust }));
vi.mock('../lib/redis', () => ({
  redis: { pipeline: () => ({ del: vi.fn(), exec: vi.fn(async () => []) }), del: vi.fn() },
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => state.selects.shift() ?? [] }) }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          state.wiped = true;
          return [{ bookId: 1 }, { bookId: 2 }];
        },
      }),
    }),
  },
}));

import { userBooksService } from '../services/user-books.service';

const USER_ID = 7;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function googleToken(authAgeSeconds: number) {
  return {
    uid: 'google-uid-1',
    auth_time: nowSeconds() - authAgeSeconds,
    firebase: { sign_in_provider: 'google.com' },
  };
}

describe('library reset re-authentication', () => {
  beforeEach(() => {
    state.selects = [];
    state.wiped = false;
    verifyIdToken.mockReset();
    bust.mockClear();
  });

  it("refuses a fresh token for a Google account that isn't linked to this user", async () => {
    verifyIdToken.mockResolvedValue(googleToken(30));
    state.selects = [[]]; // no matching provider row

    await expect(userBooksService.resetLibrary(USER_ID, { idToken: 'tok' })).rejects.toMatchObject({
      statusCode: 401,
      message: 'Incorrect sign-in',
    });
    expect(state.wiped).toBe(false);
  });

  it('clears the shelf with a fresh token from a linked provider', async () => {
    verifyIdToken.mockResolvedValue(googleToken(30));
    state.selects = [[{ id: 1 }]];

    await expect(userBooksService.resetLibrary(USER_ID, { idToken: 'tok' })).resolves.toEqual({ deleted: 2 });
    expect(state.wiped).toBe(true);
    expect(bust).toHaveBeenCalledWith(USER_ID);
  });

  it('refuses a token from a sign-in more than 5 minutes old', async () => {
    verifyIdToken.mockResolvedValue(googleToken(10 * 60));

    await expect(userBooksService.resetLibrary(USER_ID, { idToken: 'tok' })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(state.wiped).toBe(false);
  });

  it('refuses a password on an account that has none', async () => {
    state.selects = [[{ passwordHash: null }]];

    await expect(userBooksService.resetLibrary(USER_ID, { password: 'guess' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(state.wiped).toBe(false);
  });
});
