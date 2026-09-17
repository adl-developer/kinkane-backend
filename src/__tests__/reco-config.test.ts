import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * How the recommendation settings behave at boot: what they default to, when
 * the server warns, and when it refuses to start.
 *
 * Each case loads config/index.ts fresh against its own environment. The
 * config calls process.exit on an invalid combination, so exit is stubbed to
 * throw — a refused boot then shows up as a rejected import instead of taking
 * the test run down with it.
 */

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

async function boot(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(code);
  });

  try {
    const { config } = await import('../config');
    return { config, warn, error, exit, exitCode: undefined as number | string | null | undefined };
  } catch (e) {
    if (e instanceof ExitCalled) return { config: undefined, warn, error, exit, exitCode: e.code };
    throw e;
  }
}

const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = warnings;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('stored-embeddings switch', () => {
  it('is off unless asked for', async () => {
    const { config } = await boot();
    expect(config!.recommendations.booksFromEmbeddings).toBe(false);
  });

  it('reads "true" as on and anything else as off', async () => {
    expect((await boot({ RECO_BOOKS_FROM_EMBEDDINGS: 'true' })).config!.recommendations.booksFromEmbeddings).toBe(true);
    expect((await boot({ RECO_BOOKS_FROM_EMBEDDINGS: 'yes' })).config!.recommendations.booksFromEmbeddings).toBe(false);
  });
});

describe('cutoffs left at their titles-era values', () => {
  const STALE = 'RECO_SIMILARITY_MAX is still';

  it('warns when the embeddings lane is on but the strict cutoff was never retuned', async () => {
    const { config, warn } = await boot({
      RECO_BOOKS_FROM_EMBEDDINGS: 'true',
      RECO_SIMILARITY_MAX: '0.5',
      RECO_BACKFILL_MAX: '0.7',
    });
    // A warning, not a refusal — the search still works, the tiers just stop meaning anything.
    expect(config).toBeDefined();
    expect(warnings(warn)).toContain(`${STALE} 0.5`);
  });

  it('warns from 0.4 upwards', async () => {
    const { warn } = await boot({
      RECO_BOOKS_FROM_EMBEDDINGS: 'true',
      RECO_SIMILARITY_MAX: '0.4',
      RECO_BACKFILL_MAX: '0.5',
    });
    expect(warnings(warn)).toContain(STALE);
  });

  it('stays quiet at retuned cutoffs', async () => {
    const { warn } = await boot({
      RECO_BOOKS_FROM_EMBEDDINGS: 'true',
      RECO_SIMILARITY_MAX: '0.25',
      RECO_BACKFILL_MAX: '0.32',
    });
    expect(warnings(warn)).not.toContain(STALE);
  });

  it('stays quiet at 0.5 while the titles lane is still in use, since that is what 0.5 was tuned for', async () => {
    const { warn } = await boot({
      RECO_BOOKS_FROM_EMBEDDINGS: 'false',
      RECO_SIMILARITY_MAX: '0.5',
      RECO_BACKFILL_MAX: '0.7',
    });
    expect(warnings(warn)).not.toContain(STALE);
  });
});
