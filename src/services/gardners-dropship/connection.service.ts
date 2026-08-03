/**
 * FTP connection handling for Gardners' I12 Home Delivery (dropship)
 * account. Confirmed live (2026-08-03): this account is explicit FTPS
 * ("FTPeS") on orders.gardners.com — a different protocol AND host from
 * onix_ingester's SFTP-based Bespoke Inventory / Generic Data feed
 * accounts, despite sharing the same "KIN155FTP"-style username convention.
 * Do not assume the two are interchangeable.
 *
 * Directory names on the real server are lowercase (`homeord`, `homeack`,
 * etc.) — the spec PDF prints them uppercase (HOMEORD, HOMEACK), but FTP
 * paths are case-sensitive on Gardners' server, confirmed by directly
 * listing it.
 *
 * Order/ack files here are tiny (a handful of KB at most), so unlike the
 * catalogue feeds there's no need for concurrent/chunked transfers — a
 * plain upload/download per call is fine, and each call opens and closes
 * its own connection rather than holding one open across a poll loop.
 */
import { Readable, Writable } from 'stream';
import { Client as FtpClient, FileInfo } from 'basic-ftp';
import { config } from '../../config';

export const HOME_DELIVERY_DIRS = {
  order: 'homeord',
  ack: 'homeack',
  dispatch: 'homedisp',
  general: 'homegen',
  preDispatch: 'homepre',
} as const;

function requireCredentials() {
  const { host, port, username, password } = config.gardnersDropship.ftp;
  if (!host || !username || !password) {
    throw new Error(
      'Gardners dropship FTP is not configured — set GARDNERS_DROPSHIP_FTP_HOST/USERNAME/PASSWORD ' +
        '(and GARDNERS_DROPSHIP_ACCOUNT_CODE) before submitting or polling orders.',
    );
  }
  return { host, port, username, password };
}

export async function withDropshipFtp<T>(fn: (client: FtpClient) => Promise<T>): Promise<T> {
  const { host, port, username, password } = requireCredentials();
  const client = new FtpClient();
  await client.access({ host, port, user: username, password, secure: true });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export async function listFiles(client: FtpClient, dirPath: string): Promise<FileInfo[]> {
  return client.list(dirPath);
}

export async function fileExists(client: FtpClient, path: string): Promise<boolean> {
  try {
    await client.size(path);
    return true;
  } catch {
    return false;
  }
}

export async function uploadBuffer(client: FtpClient, buffer: Buffer, remotePath: string): Promise<void> {
  await client.uploadFrom(Readable.from(buffer), remotePath);
}

/** Downloads a small remote file into memory — only used for order/ack files (a few KB), never large feeds. */
export async function downloadBuffer(client: FtpClient, remotePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await client.downloadTo(sink, remotePath);
  return Buffer.concat(chunks);
}

export async function removeFile(client: FtpClient, remotePath: string): Promise<void> {
  await client.remove(remotePath);
}
