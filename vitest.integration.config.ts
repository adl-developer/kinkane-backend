import { defineConfig } from 'vitest/config';

/**
 * Integration tests that WRITE to a database.
 *
 * Separate from both other configs for one reason: the unit suite never
 * touches Postgres, and the endpoint contract suite deliberately only reads
 * from it ("mutating endpoints are never executed"). These tests insert and
 * truncate rows, so they must never be pointed at the database in `.env` —
 * which on this project is production.
 *
 * They run against TEST_DATABASE_URL and skip themselves entirely when it is
 * not set, so `npm run test:all` stays green on a machine without one. Each
 * test file is responsible for refusing to run against the configured
 * production URL; see nielsen-budget.integration.test.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.integration.test.ts'],
    // No hermetic-env setup: these need the real environment, with
    // TEST_DATABASE_URL substituted in for DATABASE_URL by the test itself.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
