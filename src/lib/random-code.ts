import crypto from 'crypto';

/**
 * Random, human-transcribable identifiers.
 *
 * Crockford base32 minus the characters people misread or mistype when copying
 * something off a screen: I, L, O and U are absent. Both users of this — referral
 * codes and payment references — get read aloud, retyped, and pasted into
 * support conversations far more often than a password ever is.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Rejection sampling rather than `byte % alphabet.length`.
 *
 * 256 happens to be a multiple of 32 today, so the modulo would be unbiased —
 * but the alphabet is a constant somebody will eventually edit, and a silent
 * modulo bias in the one function that has to be unpredictable is not a trap
 * worth leaving behind.
 */
export function randomCode(length: number, alphabet: string = CROCKFORD_ALPHABET): string {
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new Error('randomCode alphabet must be between 2 and 256 characters');
  }

  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';

  // Bounded so a pathological alphabet can't spin forever. With the shipped
  // 32-character alphabet nothing is ever rejected, and even the worst legal
  // alphabet (129 characters, ~50% rejection) finishes inside this in every
  // practical case — so exhausting it means the random source is broken, which
  // is worth an error rather than a hang.
  for (let round = 0; out.length < length && round < 1000; round++) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= max) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }

  if (out.length < length) {
    throw new Error('randomCode could not gather enough unbiased random bytes');
  }

  return out;
}
