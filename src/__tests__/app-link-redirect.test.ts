import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../config', () => ({ config: { appUrl: 'https://kinkane.app' } }));

import appLinkRedirectRoutes from '../routes/app-link-redirect.routes';
import { appLink } from '../lib/app-link';

// /redirect/* is what a browser sees when an app link didn't open the app. It
// has to land the reader on the same page the app would have shown, and it sits
// on the public domain, so it must not be usable to bounce someone off-site.

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/redirect', appLinkRedirectRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function follow(path: string) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control') };
}

describe('appLink', () => {
  it('puts every app link under /redirect', () => {
    expect(appLink('/books/42')).toBe('https://kinkane.app/redirect/books/42');
    expect(appLink()).toBe('https://kinkane.app/redirect');
  });
});

describe('GET /redirect/*', () => {
  it('forwards to the same path without the prefix', async () => {
    expect(await follow('/redirect/books/42')).toMatchObject({
      status: 302,
      location: 'https://kinkane.app/books/42',
    });
  });

  it('keeps the query string, which is where Stripe returns and tokens live', async () => {
    const { location } = await follow('/redirect/account/subscription?checkout=success');
    expect(location).toBe('https://kinkane.app/account/subscription?checkout=success');

    const reset = await follow('/redirect/reset-password?token=abc%2B123');
    expect(reset.location).toBe('https://kinkane.app/reset-password?token=abc%2B123');
  });

  it('sends the bare prefix to the home page', async () => {
    expect((await follow('/redirect')).location).toBe('https://kinkane.app/');
    expect((await follow('/redirect/')).location).toBe('https://kinkane.app/');
  });

  it('cannot be turned into an open redirect', async () => {
    // Resolving "//evil.com" against the base would yield https://evil.com/.
    for (const path of ['/redirect//evil.com', '/redirect///evil.com/x', '/redirect/%2F%2Fevil.com']) {
      const { location } = await follow(path);
      expect(new URL(location!).origin).toBe('https://kinkane.app');
    }
  });

  it('is never cached, because some of these links carry single-use tokens', async () => {
    expect((await follow('/redirect/cancel-email-change?token=t')).cache).toBe('no-store');
  });
});
