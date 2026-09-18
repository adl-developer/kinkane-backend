import { describe, it, expect } from 'vitest';
import { isCloudinaryUrl } from '../lib/cloudinary-url';
import { config } from '../config';

// The server never receives an upload — the client uploads straight to
// Cloudinary and sends us the URL — so this predicate is the only thing between
// a user-supplied string and a stored image reference. The path-prefix half is
// the one that is easy to drop while "simplifying", and dropping it re-opens
// hotlinking from any other tenant on Cloudinary's shared domain.

// Built from the configured cloud name rather than a literal, so the test
// keeps testing the prefix rule rather than one hard-coded account.
const CLOUD = config.cloudinary.cloudName;

describe('isCloudinaryUrl', () => {
  it('accepts an image in our own cloud', () => {
    expect(isCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/group.jpg`)).toBe(true);
  });

  it('rejects another tenant on the same host', () => {
    // Same hostname, different cloud name — this is the case the hostname check
    // alone would wave through.
    expect(isCloudinaryUrl('https://res.cloudinary.com/someone-else/image/upload/v1/x.jpg')).toBe(false);
  });

  it('rejects a cloud name that merely starts with ours', () => {
    // The trailing slash in the prefix is load-bearing: without it
    // "kinkane-evil" passes as "kinkane".
    expect(isCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}-evil/image/upload/x.jpg`)).toBe(false);
  });

  it('rejects a lookalike host', () => {
    expect(isCloudinaryUrl(`https://res.cloudinary.com.evil.test/${CLOUD}/x.jpg`)).toBe(false);
    expect(isCloudinaryUrl(`https://evil.test/${CLOUD}/x.jpg`)).toBe(false);
  });

  it('returns false rather than throwing on an unparseable string', () => {
    // Callers use this inside a zod .refine(), where a throw would surface as a
    // 500 instead of a validation error.
    expect(isCloudinaryUrl('not a url')).toBe(false);
    expect(isCloudinaryUrl('')).toBe(false);
  });
});
