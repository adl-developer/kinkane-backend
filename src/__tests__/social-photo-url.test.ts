import { describe, it, expect } from 'vitest';
import { usableSocialPhotoUrl } from '../lib/social-photo-url';

describe('usableSocialPhotoUrl', () => {
  it('keeps a Google photo URL longer than 1,000 characters', () => {
    // The real failure: a 1,129-character Google URL broke social sign-in.
    const url = `https://lh3.googleusercontent.com/a-/${'A'.repeat(1100)}=s96-c`;
    expect(url.length).toBeGreaterThan(1000);
    expect(usableSocialPhotoUrl(url)).toBe(url);
  });

  it('drops a missing or empty photo', () => {
    expect(usableSocialPhotoUrl(undefined)).toBeNull();
    expect(usableSocialPhotoUrl(null)).toBeNull();
    expect(usableSocialPhotoUrl('')).toBeNull();
  });

  it('drops a URL too long to be a real photo', () => {
    expect(usableSocialPhotoUrl(`https://example.com/${'a'.repeat(9000)}`)).toBeNull();
  });

  it('drops anything that is not an http(s) URL', () => {
    expect(usableSocialPhotoUrl('not a url')).toBeNull();
    expect(usableSocialPhotoUrl('javascript:alert(1)')).toBeNull();
    expect(usableSocialPhotoUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});
