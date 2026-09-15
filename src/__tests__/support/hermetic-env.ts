import { vi } from 'vitest';

/**
 * Gives the unit suite a fixed, fake environment instead of the developer's.
 *
 * Without this the suite is green in CI and red on a developer machine, which is
 * the worst of both — nobody trusts it, so nobody can gate a commit on it. Two
 * separate mechanisms leak the real environment in, and both need closing:
 *
 *  1. Tests that simulate an unconfigured deployment by deleting a key and
 *     re-importing the config. `dotenv.config()` runs again on the re-import and
 *     reads the key straight back off disk, so the deletion does nothing.
 *  2. Tests that capture `const BASE_ENV = { ...process.env }` at file load and
 *     restore it between cases. If `.env` was already loaded, that "clean"
 *     baseline carries every real value in it.
 *
 * The second is why simply stubbing dotenv is not enough: the values are already
 * in `process.env` before any test runs. So the environment is replaced outright
 * with the smallest set of keys `config/index.ts` requires — it calls
 * `process.exit(1)` without them — and dotenv is stubbed so nothing refills it.
 *
 * Deliberately absent: every optional key, in particular FOUNDING_OFFER_ENDS_AT
 * and REFERRAL_CAMPAIGN_ENDS_AT. Tests asserting "no promotion configured" are
 * asserting these are unset, and on a developer machine both are set to real
 * future dates. An optional key must NOT be added here — absence is the default
 * this file exists to guarantee. A test that needs one sets it itself.
 *
 * The endpoint contract suite does not use this file: it talks to a real
 * database and needs the real `.env`. See vitest.endpoints.config.ts.
 */
const REQUIRED_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-32',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-long-enough-32',
  GEMINI_API_KEY: 'test-gemini-key',
  RESEND_API_KEY: 'test-resend-key',
  ADMIN_TOKEN: 'test-admin-token-that-is-long-enough-to-pass',
  UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret-long-enough-to-pass',
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  // Not in the zod schema — resolveFirebaseCredentials() checks these by hand
  // and calls process.exit(1) if none of them resolve, which in a test run
  // surfaces as "process.exit unexpectedly called with 1" and takes the whole
  // file down before a single assertion runs.
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_CLIENT_EMAIL: 'test@test.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
};

// PATH and friends are kept: killing them breaks child processes and module
// resolution in ways that look nothing like an env problem.
const PRESERVED = ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'PWD', 'LANG', 'TZ'];

// Mutated in place, never reassigned. `process.env = {...}` swaps the object for
// a new one, and vitest's own vi.stubEnv / vi.unstubAllEnvs keep a reference to
// the original — so a wholesale replacement silently breaks env stubbing in any
// test that uses it, in ways that look like a bug in the code under test.
for (const key of Object.keys(process.env)) {
  if (!PRESERVED.includes(key)) delete process.env[key];
}
Object.assign(process.env, REQUIRED_TEST_ENV);

vi.mock('dotenv', async (importOriginal) => {
  // `parse` stays real — only the filesystem read is stubbed. Anything parsing
  // env-shaped text for its own reasons keeps working.
  const actual = await importOriginal<typeof import('dotenv')>();
  const config = () => ({ parsed: {} });
  return { ...actual, config, default: { ...actual, config } };
});
