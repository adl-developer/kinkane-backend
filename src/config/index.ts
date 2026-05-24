import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),

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

  // How long a guest session lives before the cleanup cron removes it.
  // Default: 24 * 3 = 72 hours (3 days). Set to e.g. 168 for a full week.
  GUEST_SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(72),
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
  },
  guestSession: {
    ttlHours: env.GUEST_SESSION_TTL_HOURS,
  },
} as const;

export type Config = typeof config;
