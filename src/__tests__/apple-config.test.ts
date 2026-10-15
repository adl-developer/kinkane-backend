import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * How the App Store product settings behave at boot. config/index.ts calls
 * process.exit on an invalid combination, so exit is stubbed to throw and a
 * refused boot shows up as a rejected import.
 */

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

async function boot(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(code);
  });

  try {
    const { config } = await import('../config');
    return { config, error, exitCode: undefined as number | string | null | undefined };
  } catch (e) {
    if (e instanceof ExitCalled) return { config: undefined, error, exitCode: e.code };
    throw e;
  }
}

const STANDARD = { APPLE_PRODUCT_PLUS_MONTHLY: '003', APPLE_PRODUCT_PLUS_ANNUAL: '002' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('App Store products', () => {
  it('maps every configured product to its plan and founding status', async () => {
    const { config } = await boot({
      ...STANDARD,
      APPLE_PRODUCT_PLUS_MONTHLY_FOUNDING: '005',
      APPLE_PRODUCT_PLUS_ANNUAL_FOUNDING: '004',
    });
    expect(config!.apple.productsById).toEqual({
      '003': { plan: 'monthly', founding: false },
      '002': { plan: 'annual', founding: false },
      '005': { plan: 'monthly', founding: true },
      '004': { plan: 'annual', founding: true },
    });
  });

  it('treats a blank founding product as unset rather than refusing to boot', async () => {
    const { config, exitCode } = await boot({
      ...STANDARD,
      APPLE_PRODUCT_PLUS_MONTHLY_FOUNDING: '',
      APPLE_PRODUCT_PLUS_ANNUAL_FOUNDING: '',
    });
    expect(exitCode).toBeUndefined();
    expect(Object.keys(config!.apple.productsById).sort()).toEqual(['002', '003']);
  });

  it('refuses to boot when a founding product repeats a standard one', async () => {
    const { exitCode, error } = await boot({ ...STANDARD, APPLE_PRODUCT_PLUS_MONTHLY_FOUNDING: '003' });
    expect(exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('must all be different App Store products');
  });

  it('refuses to boot when one product is listed under both plans', async () => {
    const { exitCode } = await boot({ ...STANDARD, APPLE_PRODUCT_PLUS_ANNUAL_FOUNDING: '003' });
    expect(exitCode).toBe(1);
  });
});
