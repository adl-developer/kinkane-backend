/**
 * SFTP connection handling for Gardners' I12 Home Delivery (dropship)
 * account. Mirrors the keepalive settings onix_ingester's Gardners feed
 * connections use (src/services/gardners/connections.service.ts there) —
 * without them, ssh2-sftp-client's default handlers just log a dropped
 * connection rather than rejecting anything, which would otherwise hang a
 * submit/poll call forever with no error surfaced.
 *
 * Order/ack files here are tiny (a handful of KB at most), so unlike the
 * catalogue feeds there's no need for fastGet/chunked downloads — plain
 * put()/get() is fine.
 */
import SftpClient from 'ssh2-sftp-client';
import { config } from '../../config';

export const HOME_DELIVERY_DIRS = {
  order: 'HOMEORD',
  ack: 'HOMEACK',
  dispatch: 'HOMEDISP',
  general: 'HOMEGEN',
  preDispatch: 'HOMEPRE',
} as const;

const SFTP_KEEPALIVE_OPTIONS = {
  keepaliveInterval: 10_000,
  keepaliveCountMax: 5,
  readyTimeout: 20_000,
};

function requireCredentials() {
  const { host, port, username, password } = config.gardnersDropship.sftp;
  if (!host || !username || !password) {
    throw new Error(
      'Gardners dropship SFTP is not configured — set GARDNERS_DROPSHIP_SFTP_HOST/USERNAME/PASSWORD ' +
        '(and GARDNERS_DROPSHIP_ACCOUNT_CODE) before submitting or polling orders.',
    );
  }
  return { host, port, username, password };
}

export async function withDropshipSftp<T>(fn: (client: SftpClient) => Promise<T>): Promise<T> {
  const { host, port, username, password } = requireCredentials();
  const client = new SftpClient();
  await client.connect({ host, port, username, password, ...SFTP_KEEPALIVE_OPTIONS });
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
