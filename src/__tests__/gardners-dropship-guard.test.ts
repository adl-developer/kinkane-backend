import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * "Nothing reaches Gardners in development" is a guarantee about a side effect
 * on someone else's server, which is the hardest kind of thing to notice going
 * wrong: a developer clicking through a local checkout with production
 * credentials in `.env` — the normal setup here, since the catalogue feeds need
 * them — would put a real order file into a real supplier's HOMEORD directory
 * and only find out when Gardners acknowledged it.
 *
 * So the guard is tested at the choke point every Home Delivery call goes
 * through, and specifically for the property that it refuses *before* it looks
 * at credentials.
 */
const BASE_ENV = { ...process.env };

async function loadConnection(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/gardners-dropship/connection.service');
}

/** Full credentials, so nothing below passes merely because config is absent. */
const CREDENTIALS = {
  GARDNERS_DROPSHIP_SFTP_HOST: 'edi.gardners.com',
  GARDNERS_DROPSHIP_SFTP_USERNAME: 'KIN155FTP',
  GARDNERS_DROPSHIP_SFTP_PASSWORD: 'hunter2',
  GARDNERS_DROPSHIP_ACCOUNT_CODE: 'KIN155',
};

afterEach(() => {
  process.env = { ...BASE_ENV };
});

describe('Gardners SFTP development guard', () => {
  it('blocks in development even with full credentials configured', async () => {
    const { isDropshipSftpBlocked } = await loadConnection({
      ...CREDENTIALS,
      NODE_ENV: 'development',
    });
    expect(isDropshipSftpBlocked()).toBe(true);
  });

  it('does not block in production', async () => {
    const { isDropshipSftpBlocked } = await loadConnection({
      ...CREDENTIALS,
      NODE_ENV: 'production',
    });
    expect(isDropshipSftpBlocked()).toBe(false);
  });

  // The one legitimate reason to talk to Gardners from a dev machine is
  // scripts/gardners-dropship-test.ts, which exists to do exactly that.
  it('yields to an explicit opt-out', async () => {
    const { isDropshipSftpBlocked } = await loadConnection({
      ...CREDENTIALS,
      NODE_ENV: 'development',
      GARDNERS_DROPSHIP_ALLOW_IN_DEV: 'true',
    });
    expect(isDropshipSftpBlocked()).toBe(false);
  });

  it('treats anything other than the literal string "true" as still blocked', async () => {
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      const { isDropshipSftpBlocked } = await loadConnection({
        ...CREDENTIALS,
        NODE_ENV: 'development',
        GARDNERS_DROPSHIP_ALLOW_IN_DEV: value,
      });
      expect(isDropshipSftpBlocked(), `value: ${JSON.stringify(value)}`).toBe(true);
    }
  });

  // The real assertion: the callback never runs, so no bytes are sent. If the
  // guard were placed after requireCredentials() this would still pass for the
  // wrong reason, which is why credentials are supplied above.
  it('refuses to open a connection, without invoking the callback', async () => {
    const { withDropshipSftp } = await loadConnection({
      ...CREDENTIALS,
      NODE_ENV: 'development',
    });

    const callback = vi.fn();
    await expect(withDropshipSftp(callback)).rejects.toThrow(/NODE_ENV is development/);
    expect(callback).not.toHaveBeenCalled();
  });

  it('names the escape hatch in the error, so the fix is not a code hunt', async () => {
    const { withDropshipSftp } = await loadConnection({
      ...CREDENTIALS,
      NODE_ENV: 'development',
    });
    await expect(withDropshipSftp(async () => undefined)).rejects.toThrow(
      /GARDNERS_DROPSHIP_ALLOW_IN_DEV/,
    );
  });
});
