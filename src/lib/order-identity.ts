/**
 * Identity and bearer credentials for orders.
 *
 * Two different secrets live here and they are not interchangeable:
 *
 *  - **The reference** (`ORD-7K2M9QX4`) is an *identifier*. It appears in
 *    emails, in the order confirmation UI, and in support conversations. It is
 *    random only so that orders cannot be enumerated — it is not a credential
 *    and must never be the sole thing gating access to an order.
 *  - **The access token** is a *credential*. It is what actually authorises a
 *    guest to read or claim their order, it is 256 bits, and only its SHA-256
 *    is ever stored.
 *
 * Conflating the two is the classic way order-lookup endpoints leak: a
 * reference is quotable and gets pasted into support tickets and screenshots,
 * so anything that treats it as a password inherits every place it has been
 * written down. That is why "Track My Order" asks for the reference *and* the
 * email the order was placed with: the pair is what makes a quotable
 * identifier safe to look up on.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { randomCode } from './random-code';

/**
 * Crockford base32 minus the characters that get misread when a reference is
 * read down a phone line or retyped from a printed receipt: I, L, O and U are
 * all absent (U additionally to avoid generating unfortunate words).
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_LENGTH = 8;

/** Length of the legacy tracking code. See generateTrackingCode. */
export const TRACKING_CODE_LENGTH = 8;

/**
 * ~40 bits of entropy. Not a security boundary on its own — the access token
 * is — but enough that the reference space cannot be walked, which is what
 * turns "guess an order id" from an afternoon into an impossibility.
 */
export function generateOrderReference(): string {
  // Rejection-free because 256 is an exact multiple of 32: every byte maps to
  // one symbol with uniform probability. Taking `byte % 32` on an alphabet
  // whose length did not divide 256 would bias the early characters.
  const bytes = randomBytes(REFERENCE_LENGTH);
  let out = '';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `ORD-${out}`;
}

/** The bearer credential handed to a guest at checkout. 256 bits. */
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex. Fast on purpose — these are high-entropy random tokens, not
 * user-chosen passwords, so a slow KDF would buy nothing and cost latency on
 * every cart read. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Lookups are by hash equality in SQL, which is not constant time — but that
 * only reveals whether a row exists, never how close a guess was. Where a hash
 * is compared in application code, use this rather than `===`.
 */
export function tokensMatch(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * The short code that used to be typed into "Track My Order".
 *
 * **Nothing customer-facing reads this any more.** Tracking is by order
 * reference plus contact email, so a customer sees one identifier instead of
 * choosing between two that looked alike. The column is still `NOT NULL
 * UNIQUE` and still populated at checkout, so orders written before and after
 * the change look the same to support and to anything reading history.
 *
 * Eight Crockford base32 characters (~40 bits) with no `ORD-` prefix.
 *
 * Distinct from `orders.tracking_number`, which is the *carrier's* number
 * recovered from a Gardners dispatch file and only exists once a parcel ships.
 */
export function generateTrackingCode(): string {
  return randomCode(TRACKING_CODE_LENGTH);
}

/**
 * Turns what a customer typed into the canonical `ORD-XXXXXXXX` form.
 *
 * The reference is the one string a customer is now asked for, so this is
 * deliberately forgiving: case is ignored, spaces and dashes are stripped, and
 * the `ORD` prefix is optional — someone reading the tail off a screen has
 * typed a valid reference.
 *
 * Stripping a leading `ORD` cannot eat part of a real code: `O` is not in
 * `REFERENCE_ALPHABET`, so no reference body can begin with those letters.
 *
 * Returns the normalised string without validating it. The caller decides
 * whether the result is a well-formed reference.
 */
export function normalizeReference(input: string): string {
  const bare = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/^ORD/, '');
  return `ORD-${bare}`;
}
