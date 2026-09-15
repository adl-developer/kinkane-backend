import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The contract suite needs a live database, so it is not part of the default
    // run — it has its own config and script. Leaving it here would make
    // `npm test` fail on any machine without Postgres up, and a suite that fails
    // for environmental reasons is one people start skipping.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/__tests__/endpoints.contract.test.ts'],
    // Runs before every test file. See the file for why: without it the suite
    // passes in CI and fails on any machine that has a .env.
    setupFiles: ['./src/__tests__/support/hermetic-env.ts'],
  },
});
