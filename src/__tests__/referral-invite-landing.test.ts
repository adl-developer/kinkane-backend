import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A referral link opened by someone without the app. There is no web sign-up
 * from an invite, so Android goes to the Play Store with the code in the install
 * referrer, and iPhone and computers get a page showing the code and the store
 * buttons. An unknown code still lands on the homepage, so the link can't be
 * used to test which codes exist.
 */

const { referrals, cfg } = vi.hoisted(() => ({
  referrals: { resolveCode: vi.fn(), logClick: vi.fn(async () => 7) },
  cfg: {
    appUrl: 'https://kinkane.app',
    nodeEnv: 'test',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.kinkaneapp.kinkane',
    appStoreUrl: undefined as string | undefined,
  },
}));

vi.mock('../config', () => ({ config: cfg }));
vi.mock('../services/referrals.service', () => ({ referralsService: referrals, SHARE_CHANNELS: [] }));
vi.mock('../services/referral-scoring.service', () => ({ referralScoringService: {} }));
vi.mock('../services/referral-analytics.service', () => ({ referralAnalyticsService: {} }));
vi.mock('../services/geo.service', () => ({ geoService: { resolveFromRequest: vi.fn(async () => ({ code: null })) } }));
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn() }));
vi.mock('../db', () => ({ db: {} }));

import { referralsController } from '../controllers/referrals.controller';
import { detectInvitePlatform, playStoreInviteUrl } from '../lib/invite-landing';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.get('/r/:code/:slug', referralsController.redirect);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  referrals.resolveCode.mockResolvedValue({ id: 1, userId: 9 });
  cfg.appStoreUrl = undefined;
});

async function open(path: string, ua: string) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control'), body: await res.text() };
}

describe('detectInvitePlatform', () => {
  it('tells the three apart', () => {
    expect(detectInvitePlatform(ANDROID)).toBe('android');
    expect(detectInvitePlatform(IPHONE)).toBe('ios');
    expect(detectInvitePlatform(DESKTOP)).toBe('other');
    expect(detectInvitePlatform(undefined)).toBe('other');
  });
});

describe('playStoreInviteUrl', () => {
  it('nests the referrer as one encoded parameter', () => {
    expect(playStoreInviteUrl(cfg.playStoreUrl, 'K7M2QX', 'whatsapp')).toBe(
      'https://play.google.com/store/apps/details?id=com.kinkaneapp.kinkane&referrer=ref%3DK7M2QX%26c%3Dwhatsapp',
    );
  });

  it('leaves the channel out when there is none', () => {
    expect(playStoreInviteUrl(cfg.playStoreUrl, 'K7M2QX', undefined)).toContain('referrer=ref%3DK7M2QX');
    expect(playStoreInviteUrl(cfg.playStoreUrl, 'K7M2QX', undefined)).not.toContain('%26c');
  });
});

describe('GET /r/:code/:slug', () => {
  it('sends Android to the Play Store with the code and channel', async () => {
    const res = await open('/r/k7m2qx/ama?c=whatsapp', ANDROID);
    expect(res.status).toBe(302);
    expect(res.location).toBe(
      'https://play.google.com/store/apps/details?id=com.kinkaneapp.kinkane&referrer=ref%3DK7M2QX%26c%3Dwhatsapp',
    );
    expect(res.cache).toBe('no-store');
  });

  it('drops an unrecognised channel from the referrer', async () => {
    const res = await open('/r/K7M2QX/ama?c=%26ref%3DEVIL', ANDROID);
    expect(res.location).toBe('https://play.google.com/store/apps/details?id=com.kinkaneapp.kinkane&referrer=ref%3DK7M2QX');
  });

  it('shows iPhone the code and the App Store button, not Google Play', async () => {
    cfg.appStoreUrl = 'https://apps.apple.com/app/id123456789';
    const res = await open('/r/k7m2qx/ama', IPHONE);
    expect(res.status).toBe(200);
    expect(res.body).toContain('K7M2QX');
    expect(res.body).toContain('https://apps.apple.com/app/id123456789');
    expect(res.body).not.toContain('play.google.com');
    expect(res.body).not.toContain('<script');
  });

  it('tells iPhone to search the App Store while no App Store URL is set', async () => {
    const res = await open('/r/K7M2QX/ama', IPHONE);
    expect(res.body).toContain('Search for “Kinkané” in the App Store');
    expect(res.body).not.toContain('apps.apple.com');
  });

  it('shows a computer the code and both store buttons', async () => {
    cfg.appStoreUrl = 'https://apps.apple.com/app/id123456789';
    const res = await open('/r/K7M2QX/ama', DESKTOP);
    expect(res.status).toBe(200);
    expect(res.body).toContain('K7M2QX');
    expect(res.body).toContain('apps.apple.com');
    expect(res.body).toContain('play.google.com');
    expect(res.body).not.toContain('/invite');
  });

  it('still sends an unknown code to the homepage on every device', async () => {
    referrals.resolveCode.mockResolvedValue(null);
    for (const ua of [ANDROID, IPHONE, DESKTOP]) {
      expect(await open('/r/NOPE12/ama', ua)).toMatchObject({ status: 302, location: 'https://kinkane.app' });
    }
  });
});
