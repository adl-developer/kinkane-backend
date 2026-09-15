import { defineConfig } from 'vitest/config';

/**
 * The endpoint contract suite, which needs a real database.
 *
 * Kept in its own config because it wants the opposite environment to the unit
 * suite. That one runs on a fixed fake env so it behaves identically on every
 * machine (see src/__tests__/support/hermetic-env.ts); this one needs the real
 * `.env` — a real DATABASE_URL above all — because talking to Postgres is the
 * entire point of it.
 *
 * Single-threaded and serial: it binds a port and issues a few hundred requests
 * through the app's rate limiters. Running files in parallel would have them
 * competing for both.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/endpoints.contract.test.ts'],
    // No hermetic-env setup here — the real .env is wanted.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
