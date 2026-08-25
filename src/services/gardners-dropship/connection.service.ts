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

/**
 * Whether talking to Gardners is currently forbidden.
 *
 * **In development, nothing reaches Gardners' SFTP at all** — not an order
 * file, not an ack poll, not a directory listing. A developer running the API
 * locally with production credentials in `.env` (which is the normal setup
 * here, since the catalogue feeds need them) would otherwise put real order
 * files into a real supplier's HOMEORD directory as a side effect of clicking
 * through a checkout. `TESTING=Y` on the order is not sufficient protection:
 * it is a per-order flag someone can turn off, and it still transmits.
 *
 * This is the single choke point for the Home Delivery account, so the guard
 * covers the queued fulfilment worker, the ack-polling cron, and the admin
 * endpoint alike.
 *
 * `GARDNERS_DROPSHIP_ALLOW_IN_DEV=true` is the deliberate opt-out, and exists
 * for exactly one reason: `scripts/gardners-dropship-test.ts` is a manual tool
 * whose entire purpose is to talk to Gardners from a developer machine. It
 * defaults to false, so the guarantee holds unless someone consciously sets it.
 */
export function isDropshipSftpBlocked(): boolean {
  return config.nodeEnv === 'development' && !config.gardnersDropship.allowInDev;
}

/** Thrown instead of connecting when {@link isDropshipSftpBlocked} holds. */
export class DropshipSftpBlockedError extends Error {
  constructor() {
    super(
      'Refusing to contact Gardners SFTP: NODE_ENV is development. ' +
        'Set GARDNERS_DROPSHIP_ALLOW_IN_DEV=true only if you intend to send real traffic to the supplier.',
    );
    this.name = 'DropshipSftpBlockedError';
  }
}

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
  // Checked before credentials, so a blocked environment fails the same way
  // whether or not real credentials happen to be present.
  if (isDropshipSftpBlocked()) {
    throw new DropshipSftpBlockedError();
  }

  const { host, port, username, password } = requireCredentials();
  const client = new SftpClient();
  await client.connect({ host, port, username, password, ...SFTP_KEEPALIVE_OPTIONS });
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
