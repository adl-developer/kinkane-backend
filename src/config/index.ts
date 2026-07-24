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

  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(1),

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

  SENDGRID_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email().default('hello@kinkane.com'),
  EMAIL_FROM_NAME: z.string().default('Kinkane'),

  // Frontend base URL — used to build links in emails (e.g. password reset)
  APP_URL: z.string().url().default('https://kinkane.com'),

  // Secret token for accessing the Bull Board admin dashboard (/admin/queues).
  // Must be at least 32 characters. Generate with: openssl rand -hex 32
  ADMIN_TOKEN: z.string().min(32),

  // Cloudinary cloud name — used to validate that uploaded photo URLs belong
  // to this project's Cloudinary account, not an arbitrary third-party account.
  CLOUDINARY_CLOUD_NAME: z.string().min(1),

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
  firebase: {
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    // Render/env files escape newlines as \n literals — unescape them
    privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    flashModel: env.GEMINI_FLASH_MODEL,
    flashModelFallback: env.GEMINI_FLASH_MODEL_FALLBACK,
  },
  guestSession: {
    ttlHours: env.GUEST_SESSION_TTL_HOURS,
  },
  sendgrid: {
    apiKey: env.SENDGRID_API_KEY,
    from: env.EMAIL_FROM,
    fromName: env.EMAIL_FROM_NAME,
  },
  appUrl: env.APP_URL,
  adminToken: env.ADMIN_TOKEN,
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
  },
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
