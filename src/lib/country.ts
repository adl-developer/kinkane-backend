/**
 * ISO-3166 alpha-2 country code normalization.
 *
 * One implementation, shared: currency display, shipping and tax quoting, and
 * referral scoring all have to agree about what counts as a country. They used
 * to each carry their own copy of this test, which meant a change to the rule
 * — a new sentinel value to reject, say — could be applied to one and silently
 * missed on the others.
 */

/**
 * Returns the upper-cased two-letter code, or null when the input isn't one.
 *
 * Rejects Cloudflare's two sentinel values along with everything else that
 * isn't two ASCII letters: `XX` (it could not resolve the country) and `T1`
 * (the request came out of the Tor network). Neither is a place, and treating
 * either as one would mean quoting shipping to a country that doesn't exist.
 * `T1` is caught by the letters-only test rather than by name.
 */
export function normalizeCountryCode(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX') return null;
  return code;
}
