/**
 * Redacts session credentials before a log line is written.
 *
 * The two things this file exists to hide, whether they surface as a field,
 * a nested field, a substring of one, or an array of one:
 *
 *   1. **JWT access tokens.** Three base64url segments separated by dots,
 *      the first segment beginning with `eyJ` — the base64 encoding of the
 *      literal `{"`, which every signed JWT header decodes to and no
 *      dotted identifier that isn't a JWT ever starts with.
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
 * all replaced.
 */
const SCRUB_RULES: RegExp[] = [
  // JWT: `eyJ` + rest-of-header-segment . payload . signature. The `eyJ`
  // anchor is what stops false positives on generic dotted identifiers —
  // build stamps like `20260101.abc12345.f00dcafe` used to match because
  // three base64url-safe segments were all the pattern required. Every
  // signed JWT header decodes to JSON starting with `{"`, whose base64
  // encoding always begins `eyJ`, so no real JWT loses coverage.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Refresh token: exactly 80 lowercase hex characters.
  /\b[a-f0-9]{80}\b/g,
];

/**
 * Sentinel written when the walker meets an object it has already visited
 * during the same scrub. Anything more elaborate than a string would leave
 * the shape ambiguous — a bare `[Circular]` looks like a JSON-serialiser
 * marker to a human reader and does not itself match any scrub rule.
 */
const CIRCULAR = '[Circular]';

/**
 * Recursively walks a log context and returns a new structure with any
 * string value scrubbed against SCRUB_RULES.
 *
 * Returns a **new** structure rather than mutating in place: the store
 * used by AsyncLocalStorage is shared across every log line in one
 * request, and mutating it would blur values in fields that other code
 * holds by reference.
 *
 * Any non-null object is walked, not just plain object literals. That
 * includes Error, Map/Set-like carriers, `Object.create(null)` results
 * (Express 5's `req.query` is one), and class instances — a JWT buried
 * on an error's `cause` chain, or in a wrapper library's own carrier
 * class, is redacted the same way one at the top level is. The walker
 * uses `Object.entries`, so only own enumerable string keys are read;
 * getters that throw and prototype-inherited fields are left alone.
 *
 * A WeakSet threads through the recursion so a cyclic value — every
 * Express `req` is one, since `req.res.req === req` — is replaced with
 * `CIRCULAR` instead of blowing the stack. Before this guard, the
 * previous `JSON.stringify` step caught the same case with a clean
 * TypeError; the new walker matches that with an explicit sentinel.
 */
export function scrubContext<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') {
    return scrubString(value) as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const object = value as object;
  if (seen.has(object)) {
    return CIRCULAR as unknown as T;
  }
  seen.add(object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubContext(item, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubContext(entry, seen);
  }
  return out as T;
}

/** Applies every SCRUB_RULES pattern to a single string. */
export function scrubString(input: string): string {
  let result = input;
  for (const pattern of SCRUB_RULES) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
