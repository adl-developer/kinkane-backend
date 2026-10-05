import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { SubscriptionPlan, SubscriptionStatus, SubscriptionTier } from '../db/schema';

/**
 * App Store Server API client, for Kinkané Plus bought inside the iOS app.
 *
 * Everything this server believes about an Apple subscription comes from a
 * call it made itself to Apple's API, authenticated with our own key over TLS.
 * Data handed to us by the app or posted to the notification endpoint is only
 * ever used to learn *which* transaction to ask Apple about — never as proof
 * of what was bought. That is why the signed payloads below are decoded but
 * not signature-checked: a forged one can at most make us re-read the truth.
 *
 * Config is optional at boot, as with Stripe (src/lib/stripe.ts): a missing key
 * fails the Apple routes with a 503, not the whole process.
 */

const PRODUCTION_URL = 'https://api.storekit.itunes.apple.com';
const SANDBOX_URL = 'https://api.storekit-sandbox.itunes.apple.com';

/** Where an iPhone user manages an App Store subscription. */
export const APPLE_MANAGE_URL = 'https://apps.apple.com/account/subscriptions';

export type AppleEnvironment = 'Production' | 'Sandbox';

/** Subscription status codes from Get All Subscription Statuses. */
export const APPLE_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  BILLING_GRACE_PERIOD: 4,
  REVOKED: 5,
} as const;

/** The fields of JWSTransactionDecodedPayload this server reads. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate?: number;
  expiresDate?: number;
  /** The UUID the app passed at purchase — see appAccountTokenFor. */
  appAccountToken?: string;
  revocationDate?: number;
  /** Price in milliunits of `currency` (8990 = 8.99). */
  price?: number;
  currency?: string;
  environment?: AppleEnvironment;
}

/** The fields of JWSRenewalInfoDecodedPayload this server reads. */
export interface AppleRenewalInfo {
  originalTransactionId: string;
  /** 1 = will renew, 0 = the user turned renewal off. */
  autoRenewStatus?: number;
  /** The product the next renewal will bill — differs after a scheduled plan change. */
  autoRenewProductId?: string;
  gracePeriodExpiresDate?: number;
}

/** What one subscription chain looks like right now, according to Apple. */
export interface AppleSubscriptionSnapshot {
  environment: AppleEnvironment;
  status: number;
  transaction: AppleTransaction;
  renewal: AppleRenewalInfo | null;
}

/** The decoded body of an App Store Server Notification V2. */
export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: {
    bundleId?: string;
    environment?: AppleEnvironment;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
  signedDate?: number;
}

interface StatusResponse {
  environment: AppleEnvironment;
  bundleId: string;
  data: {
    subscriptionGroupIdentifier: string;
    lastTransactions: {
      originalTransactionId: string;
      status: number;
      signedTransactionInfo: string;
      signedRenewalInfo?: string;
    }[];
  }[];
}

export function isAppleConfigured(): boolean {
  const a = config.apple;
  return Boolean(
    a.issuerId && a.keyId && a.privateKey && a.bundleId && a.products.monthly && a.products.annual,
  );
}

export function assertAppleConfigured(): void {
  if (!isAppleConfigured()) {
    throw Object.assign(new Error('App Store purchases are not available right now'), {
      statusCode: 503,
      code: 'APPLE_IAP_UNAVAILABLE',
    });
  }
}

/** Which plan an App Store product id is, or null for a product that isn't Plus. */
export function planForAppleProduct(productId: string | null | undefined): SubscriptionPlan | null {
  if (!productId) return null;
  if (productId === config.apple.products.monthly) return 'monthly';
  if (productId === config.apple.products.annual) return 'annual';
  return null;
}

/**
 * The UUID the iOS app must pass as `appAccountToken` when it starts a
 * purchase. Apple stamps it on every transaction in the chain, which lets the
 * verify endpoint refuse a purchase made while signed in to a different
 * Kinkané account on the same device.
 *
 * Derived from the user id with an HMAC rather than stored, so it needs no
 * column and can't be guessed for someone else's account.
 */
export function appAccountTokenFor(userId: number): string {
  const bytes = crypto
    .createHmac('sha256', config.jwt.accessSecret)
    .update(`apple-app-account-token:${userId}`)
    .digest()
    .subarray(0, 16);
  // Shape it as an RFC 4122 v4 UUID — StoreKit rejects anything that isn't one.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reads the payload of a JWS without checking its signature. Only for data
 * that either came straight from Apple's API over TLS, or that is used solely
 * to pick which transaction to look up (see the note at the top of the file).
 */
export function decodeJws<T>(jws: string): T {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Malformed signed payload'), { statusCode: 400 });
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T;
  } catch {
    throw Object.assign(new Error('Malformed signed payload'), { statusCode: 400 });
  }
}

/**
 * Maps an Apple subscription onto our status and tier.
 *
 * Billing grace period keeps Plus, like Stripe's past_due — Apple is still
 * collecting and has told the user to fix their card. Billing *retry* without
 * a grace period does not: Apple retries for up to 60 days, far longer than
 * we'd let an unpaid Stripe subscription run, and Apple's own guidance is to
 * withhold service until the payment recovers (which arrives as DID_RENEW).
 */
export function mapAppleStatus(
  status: number,
  transaction: AppleTransaction,
): { status: SubscriptionStatus; tier: SubscriptionTier } {
  if (transaction.revocationDate) return { status: 'cancelled', tier: 'free' };
  switch (status) {
    case APPLE_STATUS.ACTIVE:
      return { status: 'active', tier: 'plus' };
    case APPLE_STATUS.BILLING_GRACE_PERIOD:
      return { status: 'past_due', tier: 'plus' };
    case APPLE_STATUS.BILLING_RETRY:
      return { status: 'past_due', tier: 'free' };
    case APPLE_STATUS.EXPIRED:
    case APPLE_STATUS.REVOKED:
    default:
      return { status: 'cancelled', tier: 'free' };
  }
}

// ── API calls ──────────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/** A signed API token. Apple caps lifetime at 60 minutes; we use 20 and renew at 15. */
function apiToken(): string {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;

  const value = jwt.sign(
    { iss: config.apple.issuerId, aud: 'appstoreconnect-v1', bid: config.apple.bundleId },
    config.apple.privateKey!,
    { algorithm: 'ES256', keyid: config.apple.keyId, expiresIn: '20m' },
  );
  cachedToken = { value, expiresAt: now + 15 * 60 * 1000 };
  return value;
}

/** Get All Subscription Statuses in one environment. Null when Apple has no such transaction there. */
async function getStatuses(
  transactionId: string,
  env: AppleEnvironment,
): Promise<StatusResponse | null> {
  const base = env === 'Production' ? PRODUCTION_URL : SANDBOX_URL;
  let res: Response;
  try {
    res = await fetch(`${base}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${apiToken()}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw Object.assign(new Error('The App Store could not be reached — please try again'), {
      statusCode: 502,
      code: 'APPLE_IAP_UPSTREAM',
      cause: err,
    });
  }

  if (res.status === 404) return null;
  if (res.status === 401) {
    // Our key, issuer or bundle id is wrong — an operator problem, not the user's.
    cachedToken = null;
    throw Object.assign(new Error('App Store rejected our API credentials'), {
      statusCode: 503,
      code: 'APPLE_IAP_UNAVAILABLE',
    });
  }
  if (!res.ok) {
    throw Object.assign(new Error('The App Store could not be reached — please try again'), {
      statusCode: 502,
      code: 'APPLE_IAP_UPSTREAM',
      cause: `App Store API ${res.status}`,
    });
  }
  return (await res.json()) as StatusResponse;
}

export const appleStore = {
  /**
   * Asks Apple for the current state of the Plus subscription that
   * `transactionId` belongs to. Any transaction id in the chain works.
   *
   * Tries Production first and falls back to Sandbox on not-found, which is
   * Apple's recommended order — App Review buys with sandbox accounts against
   * the production server.
   *
   * Returns null when Apple has no such transaction, or when it belongs to a
   * different app or isn't one of our Plus products.
   */
  async getSubscription(transactionId: string): Promise<AppleSubscriptionSnapshot | null> {
    assertAppleConfigured();

    const response =
      (await getStatuses(transactionId, 'Production')) ??
      (config.apple.allowSandbox ? await getStatuses(transactionId, 'Sandbox') : null);
    if (!response) return null;

    if (response.bundleId !== config.apple.bundleId) return null;

    for (const group of response.data ?? []) {
      for (const last of group.lastTransactions ?? []) {
        const transaction = decodeJws<AppleTransaction>(last.signedTransactionInfo);
        if (!planForAppleProduct(transaction.productId)) continue;
        return {
          environment: response.environment,
          status: last.status,
          transaction,
          renewal: last.signedRenewalInfo
            ? decodeJws<AppleRenewalInfo>(last.signedRenewalInfo)
            : null,
        };
      }
    }
    return null;
  },
};
