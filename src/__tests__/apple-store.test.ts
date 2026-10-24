import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appleStore } from '../lib/apple-store';

/**
 * Which App Store environment getSubscription asks, and what it does with each
 * answer. Apple's API is a stubbed fetch, keyed by host; the signing key is a
 * throwaway P-256 key, since the token is signed for real.
 */

const apple = vi.hoisted(() => ({
  issuerId: 'issuer',
  keyId: 'KEY1234567',
  privateKey: require('crypto')
    .generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString() as string,
  bundleId: 'com.kinkaneapp.kinkane',
  products: { monthly: '003', annual: '002' },
  productsById: {
    '003': { plan: 'monthly', founding: false },
    '002': { plan: 'annual', founding: false },
  },
  allowSandbox: true,
}));

vi.mock('../config', () => ({ config: { apple } }));


const PRODUCTION = 'api.storekit.itunes.apple.com';
const SANDBOX = 'api.storekit-sandbox.itunes.apple.com';

function jws(payload: object): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function statuses(environment: 'Production' | 'Sandbox') {
  return {
    environment,
    bundleId: apple.bundleId,
    data: [
      {
        subscriptionGroupIdentifier: 'g',
        lastTransactions: [
          {
            originalTransactionId: '1000',
            status: 1,
            signedTransactionInfo: jws({ transactionId: '1001', originalTransactionId: '1000', productId: '003' }),
          },
        ],
      },
    ],
  };
}

/** Answers each host with a status, plus a body for a 200. */
function stubApple(answers: Record<string, number>) {
  const fetch = vi.fn(async (url: string) => {
    const host = new URL(url).host;
    const status = answers[host];
    const env = host === PRODUCTION ? 'Production' : 'Sandbox';
    return new Response(status === 200 ? JSON.stringify(statuses(env)) : '', { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const hosts = (fetch: ReturnType<typeof stubApple>) => fetch.mock.calls.map(([url]) => new URL(url).host);

beforeEach(() => {
  apple.allowSandbox = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSubscription', () => {
  it('reads a production purchase without asking Sandbox', async () => {
    const fetch = stubApple({ [PRODUCTION]: 200 });
    const sub = await appleStore.getSubscription('1001');
    expect(sub?.environment).toBe('Production');
    expect(hosts(fetch)).toEqual([PRODUCTION]);
  });

  it('falls back to Sandbox when Production has no such transaction', async () => {
    const fetch = stubApple({ [PRODUCTION]: 404, [SANDBOX]: 200 });
    const sub = await appleStore.getSubscription('1001');
    expect(sub?.environment).toBe('Sandbox');
    expect(hosts(fetch)).toEqual([PRODUCTION, SANDBOX]);
  });

  it('falls back to Sandbox when Production rejects the key, as it does before the app is live', async () => {
    const fetch = stubApple({ [PRODUCTION]: 401, [SANDBOX]: 200 });
    const sub = await appleStore.getSubscription('1001');
    expect(sub?.environment).toBe('Sandbox');
    expect(hosts(fetch)).toEqual([PRODUCTION, SANDBOX]);
  });

  it('reports rejected credentials when Sandbox rejects the key too', async () => {
    stubApple({ [PRODUCTION]: 401, [SANDBOX]: 401 });
    await expect(appleStore.getSubscription('1001')).rejects.toMatchObject({
      statusCode: 503,
      code: 'APPLE_IAP_UNAVAILABLE',
    });
  });

  it('reports rejected credentials without asking Sandbox when sandbox purchases are off', async () => {
    apple.allowSandbox = false;
    const fetch = stubApple({ [PRODUCTION]: 401 });
    await expect(appleStore.getSubscription('1001')).rejects.toMatchObject({ code: 'APPLE_IAP_UNAVAILABLE' });
    expect(hosts(fetch)).toEqual([PRODUCTION]);
  });

  it('does not fall back when Production is down', async () => {
    const fetch = stubApple({ [PRODUCTION]: 500, [SANDBOX]: 200 });
    await expect(appleStore.getSubscription('1001')).rejects.toMatchObject({ code: 'APPLE_IAP_UPSTREAM' });
    expect(hosts(fetch)).toEqual([PRODUCTION]);
  });
});
