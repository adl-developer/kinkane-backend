/**
 * Generous upper bound on a provider photo URL. Google's run past 1,000
 * characters; anything near this is not a photo URL worth keeping.
 */
const MAX_SOCIAL_PHOTO_URL_LENGTH = 8192;

/**
 * The provider's photo URL if it is one we can store and show, otherwise null.
 * A profile photo is decoration: an unusable one must cost the user their
 * photo, never their sign-in.
 */
export function usableSocialPhotoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SOCIAL_PHOTO_URL_LENGTH) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}
