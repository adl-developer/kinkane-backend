import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { issuedBeforePasswordChange } from '../services/admin/auth.service';
import { byResetEmail } from '../middleware/rate-limit.middleware';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn() }));
vi.mock('../lib/redis', () => ({ redis: { call: vi.fn() } }));

describe('issuedBeforePasswordChange', () => {
  const changedAt = new Date('2026-10-12T12:00:00.700Z');
  const changedSec = Math.floor(changedAt.getTime() / 1000);

  it('revokes nothing for an admin whose password has never changed', () => {
    expect(issuedBeforePasswordChange(changedSec - 3600, null)).toBe(false);
  });

  it('refuses a session issued in an earlier second', () => {
    expect(issuedBeforePasswordChange(changedSec - 1, changedAt)).toBe(true);
  });

  it('keeps a session issued in the same second as the change', () => {
    // The fresh session change-password returns is minted in the same second
    // as the change; flooring the change time is what lets it through.
    expect(issuedBeforePasswordChange(changedSec, changedAt)).toBe(false);
    expect(issuedBeforePasswordChange(changedSec + 5, changedAt)).toBe(false);
  });

  it('refuses a token with no iat once a change has happened', () => {
    expect(issuedBeforePasswordChange(undefined, changedAt)).toBe(true);
  });
});

describe('byResetEmail', () => {
  const req = (body: unknown) => ({ body, ip: '203.0.113.7' }) as unknown as Request;

  it('keys on the address, normalised the way the lookup is', () => {
    expect(byResetEmail(req({ email: '  Ama@Kinkane.App ' }))).toBe('email:ama@kinkane.app');
    expect(byResetEmail(req({ email: 'ama@kinkane.app' }))).toBe('email:ama@kinkane.app');
  });

  it('falls back to the IP when there is no usable address', () => {
    expect(byResetEmail(req({}))).toBe('203.0.113.7');
    expect(byResetEmail(req({ email: 42 }))).toBe('203.0.113.7');
    expect(byResetEmail(req(undefined))).toBe('203.0.113.7');
  });
});
