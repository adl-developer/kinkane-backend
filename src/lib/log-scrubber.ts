/**
 * Redacts session credentials before a log line is written.
 *
 * The two things this file exists to hide, whether they surface as a field,
 * a nested field, a substring of one, or an array of one:
 *
 *   1. **JWT access tokens.** Any `x.y.z` triple where each segment is
 *      base64url — the shape a signed JWT has, and the only shape a value
 *      that isn't a JWT can practically confuse for one.
 *   2. **Refresh tokens.** 80 hex characters, produced by
 *      `crypto.randomBytes(40).toString('hex')` — the format the auth
 *      service mints.
 *
 * `Bearer <token>` in a free-form string (typically an error message that
 * echoed an inbound Authorization header) is caught by the JWT rule above,
 * which matches inside strings too.
 *
 * The email-flow tokens (password reset, email verification OTP, email
 * change OTP, unsubscribe) are deliberately out of scope: they use different
 * shapes and are not what "JWT / refresh token" covers. A future extension
 * can add them alongside — see the SCRUB_RULES table below.
 */

/**
 * The replacement written in place of a scrubbed value. Full redaction, per
 * design decision — a partial-visible variant would leak useful bytes to
 * anyone with log access without meaningfully improving debugging.
 */
const REDACTED = '****';

/**
 * The patterns hidden anywhere they appear in a log entry. Order does not
 * matter — every match is redacted, and the replacement contains no
 * characters that would match any of the other patterns.
 *
 * Each RegExp uses the `g` flag so multiple occurrences in one string are
 * all replaced. The `\b` word boundaries stop the JWT pattern from firing
 * on something like "1.2.3" (version numbers), which would otherwise match
 * — base64url includes digits.
 */
const SCRUB_RULES: RegExp[] = [
  // JWT: three base64url segments separated by dots. Requires each segment
  // to be at least 8 characters so numeric-only "a.b.c" strings don't match.
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Refresh token: exactly 80 lowercase hex characters.
  /\b[a-f0-9]{80}\b/g,
];

/**
 * Recursively walks a log context and returns a new object with any string
 * value scrubbed against SCRUB_RULES.
 *
 * Returns a **new** structure rather than mutating in place: the store used
 * by AsyncLocalStorage is shared across every log line in one request, and
 * mutating it would blur values in fields that other code has by reference.
 *
 * Non-string, non-object values (numbers, booleans, null) pass through
 * unchanged. Arrays are walked; unknown class instances are left as-is
 * because JSON.stringify would flatten them to `{}` or a class-specific
 * `toJSON()` anyway — a scrub applied to a class instance would produce a
 * plain object where the log destination expected the class output.
 */
export function scrubContext<T>(value: T): T {
  if (typeof value === 'string') {
    return scrubString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubContext(item)) as T;
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubContext(entry);
    }
    return out as T;
  }
  return value;
}

/** Applies every SCRUB_RULES pattern to a single string. */
export function scrubString(input: string): string {
  let result = input;
  for (const pattern of SCRUB_RULES) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
