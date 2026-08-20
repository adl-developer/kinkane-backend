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
  EMAIL_FROM: z.string().email().default('hello@kinkane.app'),
  EMAIL_FROM_NAME: z.string().default('Kinkane'),

  // Base client URL, and the single source of truth for every user-facing link
  // this server builds: email CTAs, password reset, Stripe return URLs, and
  // referral links (`APP_URL/r/CODE/name-slug`).
  //
  // Kinkané lives on **kinkane.app**, not .com. Anything that hardcodes a
  // domain instead of reading this is a bug — it will keep pointing at the old
  // host no matter what the environment says, and it will not fail loudly, it
  // will just send users somewhere wrong.
  APP_URL: z.string().url().default('https://kinkane.app'),

  // Secret token for accessing the Bull Board admin dashboard (/admin/queues).
  // Must be at least 32 characters. Generate with: openssl rand -hex 32
  ADMIN_TOKEN: z.string().min(32),

  // Password for the interactive API documentation at /docs. Optional, and
  // that is the security control: when it is unset the docs are not mounted at
  // all, so a deployment that never configured one does not quietly publish a
  // browsable, executable map of the whole API. Set it deliberately.
  //
  // Minimum 12 characters — this guards a UI whose "Try it out" button issues
  // real requests against whatever DATABASE_URL this process is pointed at.
  // Generate with: openssl rand -base64 24
  SWAGGER_PASSWORD: z.string().min(12).optional(),

  // How long a /docs sign-in lasts before the password is asked for again.
  SWAGGER_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(8),

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
  // Where Stripe returns the user after checkout. Default to the app URL so a
  // minimal config still works end to end.
  STRIPE_CHECKOUT_SUCCESS_URL: z.string().url().optional(),
  STRIPE_CHECKOUT_CANCEL_URL: z.string().url().optional(),

  // ── Referrals & the "Around the World" competition ─────────────────────────
  // Marketing video linked from every invite. Placeholder default until the
  // real video exists — it is an env var precisely so swapping it needs no
  // deploy.
  REFERRAL_VIDEO_URL: z.string().url().default('https://kinkane.app/about'),

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
  // Escape hatch for the one legitimate case of talking to Gardners from a
  // developer machine: scripts/gardners-dropship-test.ts. While NODE_ENV is
  // 'development' and this is false, nothing reaches Gardners' Home Delivery
  // SFTP at all — no order file, no ack poll — regardless of credentials or of
  // the per-order TESTING flag. See connection.service.ts.
  GARDNERS_DROPSHIP_ALLOW_IN_DEV: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ── Commerce ────────────────────────────────────────────────────────────────
  // Cart, checkout and order pricing. Everything here is policy, not law we
  // control, which is why it is configuration rather than code: shipping is our
  // own pricing decision, and VAT is an external rule that changes on someone
  // else's timetable. See docs/ecommerce-plan.md.

  // Country resolution is NOT configured here — commerce reads it from
  // geoService, which owns GEO_COUNTRY_HEADER and MAXMIND_DB_PATH above.
  // Currency display and referral scoring must agree about where a request
  // comes from; two independent header lookups would eventually disagree.

  // Currencies we are willing to present prices in. Kept deliberately short:
  // every entry is a live FX exposure and another rounding surface.
  SUPPORTED_CURRENCIES: z.string().default('USD,GBP,EUR'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  // country -> currency. Anything unlisted falls back to DEFAULT_CURRENCY.
  CURRENCY_BY_COUNTRY: z
    .string()
    .default('GB:GBP,IE:EUR,DE:EUR,FR:EUR,ES:EUR,IT:EUR,NL:EUR,BE:EUR,PT:EUR,AT:EUR,FI:EUR,GR:EUR'),

  // Gardners quotes GBP and only GBP, so every non-GBP price is a conversion.
  // A static table is the launch trade: no external dependency inside the
  // checkout path, at the cost of drift. FX_BUFFER_PERCENT pads the rate so a
  // few weeks of drift eats the buffer rather than the margin.
  FX_RATES_FROM_GBP: z.string().default('USD:1.27,EUR:1.17'),
  FX_BUFFER_PERCENT: z.coerce.number().min(0).max(25).default(3),

  // Shipping, in GBP pence, resolved most-specific-first:
  // country code -> region (EU/ROW) -> ROW. Gardners bills us per line, so a
  // flat per-order rate on a large basket is a deliberate margin decision.
  SHIPPING_RATES: z.string().default('GB:299,IE:599,EU:699,US:899,ROW:1199'),
  SHIPPING_PER_ITEM_GBP_PENCE: z.coerce.number().int().min(0).default(0),
  // Order subtotal (GBP pence) at or above which shipping is free. Unset = never.
  SHIPPING_FREE_THRESHOLD_GBP_PENCE: z.coerce.number().int().min(0).optional(),

  // VAT by destination country, as a percentage. Physical books are zero-rated
  // in the UK and Ireland, which is why the launch default is genuinely 0 and
  // not a simplification. This table cannot express EU OSS thresholds, US sales
  // tax nexus, or import duty — it is a documented stopgap, and `tax_source` is
  // stored per order so a later correction can find the affected rows.
  VAT_RATES: z.string().default('GB:0,IE:0,US:0'),
  VAT_DEFAULT_RATE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  // false => tax is added on top of the book price at checkout.
  // true  => the book price is treated as already including it, so a non-zero
  //          rate comes out of our margin rather than the customer's total.
  // Defaults to false: silently absorbing a destination's tax is a decision
  // that should be made on purpose, not inherited.
  VAT_PRICES_INCLUDE_TAX: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ISO country -> Gardners region code(s) from REGIONS.CSV, pipe-separated
  // where a country sits in more than one region (e.g. 'GH:AFR|WAF').
  //
  // Ships EMPTY on purpose. Gardners' region vocabulary is its own and does not
  // line up with ISO-3166, and a guessed mapping is worse than none: it would
  // silently authorise sales into territories nobody has checked the rights
  // for. While this is empty, any title that *has* market restrictions is
  // blocked from sale (titles with no restriction rows — the vast majority —
  // are unaffected). Populate it before selling restricted titles abroad.
  GARDNERS_REGION_BY_COUNTRY: z.string().default(''),

  // ISO country -> the country NAME Gardners expects in ICOUNTRY/DCOUNTRY.
  // Overrides and extends the built-in table in
  // services/commerce/gardners-countries.ts, e.g.
  //   GARDNERS_COUNTRY_NAMES_EXTRA=US:UNITED STATES OF AMERICA,TR:TURKIYE
  //
  // Exists because the authoritative list ("I12d FTP Country List.txt") is NOT
  // in the specification PDF — it is sent separately on request from
  // ITServices@gardners.com. Most of the built-in table is therefore an
  // educated guess, and this lets the real names be applied without a deploy.
  GARDNERS_COUNTRY_NAMES_EXTRA: z.string().default(''),

  // Per-line and per-cart quantity ceilings. This is a bookshop on a home
  // delivery service, not a trade counter.
  CART_MAX_QUANTITY_PER_LINE: z.coerce.number().int().min(1).default(10),
  CART_MAX_ITEMS: z.coerce.number().int().min(1).default(20),
  // How long a guest cart survives without an account behind it. Long enough
  // to span a "think about it overnight" gap, short enough that abandoned
  // guest carts are not an unbounded table. A signed-in cart never expires.
  GUEST_CART_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // Where Stripe returns the buyer after a one-time order checkout.
  STRIPE_ORDER_SUCCESS_URL: z.string().url().optional(),
  STRIPE_ORDER_CANCEL_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

/**
 * Parsers for the `A,B,C` and `KEY:VALUE,KEY:VALUE` env formats used by the
 * commerce settings.
 *
 * These deliberately **throw at boot** on anything malformed rather than
 * skipping the bad entry. Every one of these tables is money: a typo'd FX rate
 * that silently parses to NaN, or a shipping rule that quietly disappears,
 * shows up as a wrong charge on a real customer's card long before anyone
 * notices it in a log. A server that refuses to start is the cheap failure.
 */
function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMap<T>(raw: string, coerce: (value: string) => T): Record<string, T> {
  const out: Record<string, T> = {};

  for (const entry of parseList(raw)) {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new Error(`Malformed key:value config entry "${entry}" — expected KEY:VALUE`);
    }

    const key = entry.slice(0, separator).trim().toUpperCase();
    const value = coerce(entry.slice(separator + 1).trim());

    if (!key) {
      throw new Error(`Malformed key:value config entry "${entry}" — empty key`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Malformed key:value config entry "${entry}" — value is not a number`);
    }

    out[key] = value;
  }

  return out;
}

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
  swagger: {
    password: env.SWAGGER_PASSWORD,
    sessionTtlHours: env.SWAGGER_SESSION_TTL_HOURS,
    // Absence of a password is what disables the docs — see the schema above.
    enabled: env.SWAGGER_PASSWORD !== undefined,
  },
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
    allowInDev: env.GARDNERS_DROPSHIP_ALLOW_IN_DEV,
  },
  commerce: {
    currency: {
      supported: parseList(env.SUPPORTED_CURRENCIES).map((c) => c.toUpperCase()),
      default: env.DEFAULT_CURRENCY.toUpperCase(),
      byCountry: parseMap(env.CURRENCY_BY_COUNTRY, (v) => v.toUpperCase()),
      fxFromGbp: parseMap(env.FX_RATES_FROM_GBP, Number),
      bufferPercent: env.FX_BUFFER_PERCENT,
    },
    shipping: {
      rates: parseMap(env.SHIPPING_RATES, Number),
      perItemGbpPence: env.SHIPPING_PER_ITEM_GBP_PENCE,
      freeThresholdGbpPence: env.SHIPPING_FREE_THRESHOLD_GBP_PENCE,
    },
    tax: {
      rates: parseMap(env.VAT_RATES, Number),
      defaultRatePercent: env.VAT_DEFAULT_RATE_PERCENT,
      pricesIncludeTax: env.VAT_PRICES_INCLUDE_TAX,
    },
    gardnersRegionByCountry: parseMap(env.GARDNERS_REGION_BY_COUNTRY, (v) => v.toUpperCase()),
    gardnersCountryNamesExtra: parseMap(env.GARDNERS_COUNTRY_NAMES_EXTRA, (v) => v.toUpperCase()),
    cart: {
      maxQuantityPerLine: env.CART_MAX_QUANTITY_PER_LINE,
      maxItems: env.CART_MAX_ITEMS,
      guestTtlDays: env.GUEST_CART_TTL_DAYS,
    },
    orderSuccessUrl: env.STRIPE_ORDER_SUCCESS_URL ?? `${env.APP_URL}/orders?checkout=success`,
    orderCancelUrl: env.STRIPE_ORDER_CANCEL_URL ?? `${env.APP_URL}/cart?checkout=cancelled`,
  },
} as const;

export type Config = typeof config;
