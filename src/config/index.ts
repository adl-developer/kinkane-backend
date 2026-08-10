import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  ACCESS_TOKEN_TTL: z.coerce.number().default(900),        // 15 min
  REFRESH_TOKEN_TTL: z.coerce.number().default(2592000),   // 30 days

  // Firebase Admin credentials. Supply EITHER the whole service-account JSON
  // base64-encoded in FIREBASE_SERVICE_ACCOUNT_B64 (preferred — see below), or
  // the three individual fields. All are optional here because the schema
  // can't express "one of these two sets"; `resolveFirebaseCredentials()`
  // below enforces that exactly one complete set is present.
  //
  // Prefer the base64 form in any dashboard-configured environment. A PEM
  // private key pasted into a web form loses to quoting and newline mangling
  // (Render stores the value verbatim, so surrounding quotes become part of
  // the string) and surfaces only as an opaque OpenSSL "DECODER routines::
  // unsupported" error at startup. Base64 has no characters a form can mangle.
  //   base64 -i serviceAccountKey.json
  FIREBASE_SERVICE_ACCOUNT_B64: z.string().min(1).optional(),
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),

  GEMINI_API_KEY: z.string().min(1),
  // Must match the model used by onix_ingester to embed books (default: text-embedding-004)
  GEMINI_EMBEDDING_MODEL: z.string().default('text-embedding-004'),
  GEMINI_FLASH_MODEL: z.string().default('gemini-2.5-flash-lite'),
  // Used only if the primary flash model fails after exhausting retries (e.g.
  // deprecated/unavailable) — never used for embeddings, which must stay in
  // the same vector space as the books already indexed.
  GEMINI_FLASH_MODEL_FALLBACK: z.string().default('gemini-2.5-flash'),

  // How long a guest session lives before the cleanup cron removes it.
  // Default: 24 * 3 = 72 hours (3 days). Set to e.g. 168 for a full week.
  GUEST_SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(72),

  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email().default('hello@kinkane.com'),
  EMAIL_FROM_NAME: z.string().default('Kinkane'),

  // Frontend base URL — used to build links in emails (e.g. password reset)
  APP_URL: z.string().url().default('https://kinkane.com'),

  // Secret token for accessing the Bull Board admin dashboard (/admin/queues).
  // Must be at least 32 characters. Generate with: openssl rand -hex 32
  ADMIN_TOKEN: z.string().min(32),

  // Secret used to sign one-way unsubscribe tokens embedded in email footers.
  // Must be at least 32 characters. Generate with: openssl rand -hex 32
  UNSUBSCRIBE_SECRET: z.string().min(32),

  // Cloudinary cloud name — used to validate that uploaded photo URLs belong
  // to this project's Cloudinary account, not an arbitrary third-party account.
  CLOUDINARY_CLOUD_NAME: z.string().min(1),

  // Stripe — payments for Kinkané Plus.
  // All optional so the server still boots without them: local development,
  // CI and the existing deployment predate payments, and a missing key should
  // fail the one route that needs it with a clear message rather than taking
  // the whole process down at startup. `assertStripeConfigured()` in
  // src/lib/stripe.ts is what enforces their presence at the point of use.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PLUS_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_PLUS_ANNUAL: z.string().min(1).optional(),
  STRIPE_PRICE_PLUS_MONTHLY_FOUNDING: z.string().min(1).optional(),
  STRIPE_PRICE_PLUS_ANNUAL_FOUNDING: z.string().min(1).optional(),
  // While NOW() is before this, checkout uses the Founding Member prices and
  // schedules a rollover to standard pricing after the first term. Unset means
  // the launch promotion is over (or hasn't been configured), and everyone
  // gets standard pricing.
  FOUNDING_OFFER_ENDS_AT: z.coerce.date().optional(),
  // Where Stripe returns the user after checkout / billing portal. Default to
  // the app URL so a minimal config still works end to end.
  STRIPE_CHECKOUT_SUCCESS_URL: z.string().url().optional(),
  STRIPE_CHECKOUT_CANCEL_URL: z.string().url().optional(),
  STRIPE_PORTAL_RETURN_URL: z.string().url().optional(),

  // ── Referrals & the "Around the World" competition ─────────────────────────
  // Marketing video linked from every invite. Placeholder default until the
  // real video exists — it is an env var precisely so swapping it needs no
  // deploy.
  REFERRAL_VIDEO_URL: z.string().url().default('https://kinkane.com/about'),

  // While NOW() is before this, invites use the "Around the World in 80 Days"
  // launch copy; after it, the evergreen copy. Unset means the campaign is over
  // (or was never configured) and everyone gets evergreen — the safe default,
  // since the launch copy promises a challenge that may not be running.
  // Mirrors how FOUNDING_OFFER_ENDS_AT gates launch pricing.
  REFERRAL_CAMPAIGN_ENDS_AT: z.coerce.date().optional(),

  // Where a user's country comes from. Two independent sources, tried in order:
  //
  // 1. A trusted geo header set by the CDN/proxy in front of this server
  //    (Cloudflare's cf-ipcountry, Vercel's x-vercel-ip-country, and so on).
  //    Cheapest and most accurate when it exists, but ONLY trustworthy when
  //    every request genuinely passes through that proxy — a client can forge
  //    any header it likes, so leaving this set while exposing the origin
  //    directly hands users a free country picker. Unset means "don't trust
  //    any header", which is the safe default.
  // 2. A local MaxMind GeoLite2 country database, if one is on disk. Requires
  //    the optional `maxmind` package; when either is missing the lookup is
  //    skipped rather than failing, and country resolves to unknown.
  //
  // Both absent is a supported configuration: signups simply carry no country
  // and score nothing, which is strictly better than guessing.
  GEO_COUNTRY_HEADER: z.string().min(1).optional(),
  MAXMIND_DB_PATH: z.string().min(1).optional(),

  // Master switch for Plus feature gating. Off by default so the gate can be
  // deployed dark and turned on (or reverted) without shipping code.
  GATING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Gardners Books — I12 Home Delivery (dropship) ordering account. This is
  // a separate FTP account/directory set (HOMEORD/HOMEACK/etc.) from the
  // read-only catalogue feeds ingested by onix_ingester — confirm with
  // Gardners whether it shares a host with the Bespoke Inventory account or
  // needs its own credentials before pointing this at production.
  GARDNERS_DROPSHIP_SFTP_HOST: z.string().min(1).optional(),
  GARDNERS_DROPSHIP_SFTP_PORT: z.coerce.number().default(22),
  GARDNERS_DROPSHIP_SFTP_USERNAME: z.string().min(1).optional(),
  GARDNERS_DROPSHIP_SFTP_PASSWORD: z.string().min(1).optional(),
  // Your 6-character Gardners account code, quoted in every HEADER record.
  GARDNERS_DROPSHIP_ACCOUNT_CODE: z.string().length(6).optional(),
  // Default value for the HEADER TESTING flag on newly created orders.
  // Gardners acknowledges test orders normally but never creates the order
  // lines — keep this true until you deliberately want a real order placed.
  GARDNERS_DROPSHIP_DEFAULT_TESTING: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

type FirebaseCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

/**
 * Resolves Firebase Admin credentials from whichever of the two supported
 * forms is configured, preferring the base64 service-account JSON.
 *
 * Fails the process rather than returning undefined: Firebase backs Google
 * sign-in and push notifications, so booting without it produces a server
 * that looks healthy and then rejects logins at request time. Failing at
 * startup keeps that visible in the deploy logs instead. This matches the
 * previous behaviour, where the three fields were required by the schema.
 */
function resolveFirebaseCredentials(): FirebaseCredentials {
  if (env.FIREBASE_SERVICE_ACCOUNT_B64) {
    let serviceAccount: Record<string, unknown>;
    try {
      const json = Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(json);
    } catch (err) {
      console.error(
        'FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64-encoded JSON:',
        (err as Error).message,
      );
      console.error('Generate it with: base64 -i serviceAccountKey.json');
      process.exit(1);
    }

    const { project_id: projectId, client_email: clientEmail, private_key: privateKey } =
      serviceAccount as { project_id?: string; client_email?: string; private_key?: string };

    if (!projectId || !clientEmail || !privateKey) {
      console.error(
        'FIREBASE_SERVICE_ACCOUNT_B64 decoded, but is missing one of: project_id, client_email, private_key.',
      );
      console.error('Use the service-account JSON downloaded from the Firebase console verbatim.');
      process.exit(1);
    }

    // JSON.parse already turns the file's \n escapes into real newlines. The
    // unescape below is a no-op on a well-formed key and only rescues a
    // double-escaped one, which some JSON-editing tools produce.
    return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
  }

  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      // Env files and dashboards escape newlines as \n literals — unescape them.
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  console.error(
    'Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_B64 (preferred), or all of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
  );
  process.exit(1);
}

const firebaseCredentials = resolveFirebaseCredentials();

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  database: {
    url: env.DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
  },
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtl: env.REFRESH_TOKEN_TTL,
  },
  firebase: firebaseCredentials,
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    flashModel: env.GEMINI_FLASH_MODEL,
    flashModelFallback: env.GEMINI_FLASH_MODEL_FALLBACK,
  },
  guestSession: {
    ttlHours: env.GUEST_SESSION_TTL_HOURS,
  },
  email: {
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
    fromName: env.EMAIL_FROM_NAME,
  },
  appUrl: env.APP_URL,
  referrals: {
    videoUrl: env.REFERRAL_VIDEO_URL,
    campaignEndsAt: env.REFERRAL_CAMPAIGN_ENDS_AT,
    // Lower-cased once here so the header lookup never has to care about the
    // casing used in the env var — Node normalizes incoming header names, the
    // config value has to match.
    countryHeader: env.GEO_COUNTRY_HEADER?.toLowerCase(),
    maxmindDbPath: env.MAXMIND_DB_PATH,
  },
  adminToken: env.ADMIN_TOKEN,
  unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: {
      monthly: env.STRIPE_PRICE_PLUS_MONTHLY,
      annual: env.STRIPE_PRICE_PLUS_ANNUAL,
      monthlyFounding: env.STRIPE_PRICE_PLUS_MONTHLY_FOUNDING,
      annualFounding: env.STRIPE_PRICE_PLUS_ANNUAL_FOUNDING,
    },
    foundingOfferEndsAt: env.FOUNDING_OFFER_ENDS_AT,
    checkoutSuccessUrl: env.STRIPE_CHECKOUT_SUCCESS_URL ?? `${env.APP_URL}/account/subscription?checkout=success`,
    checkoutCancelUrl: env.STRIPE_CHECKOUT_CANCEL_URL ?? `${env.APP_URL}/account/subscription?checkout=cancelled`,
    portalReturnUrl: env.STRIPE_PORTAL_RETURN_URL ?? `${env.APP_URL}/account/subscription`,
  },
  gatingEnabled: env.GATING_ENABLED,
  gardnersDropship: {
    sftp: {
      host: env.GARDNERS_DROPSHIP_SFTP_HOST,
      port: env.GARDNERS_DROPSHIP_SFTP_PORT,
      username: env.GARDNERS_DROPSHIP_SFTP_USERNAME,
      password: env.GARDNERS_DROPSHIP_SFTP_PASSWORD,
    },
    accountCode: env.GARDNERS_DROPSHIP_ACCOUNT_CODE,
    defaultTesting: env.GARDNERS_DROPSHIP_DEFAULT_TESTING,
  },
} as const;

export type Config = typeof config;
