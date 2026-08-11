/**
 * Building redirect URLs that carry a parameter back to the client.
 *
 * Exists because string-concatenating `&key=value` onto a configured URL is
 * only correct when that URL already has a query string. The defaults do, so
 * the bug hides until an operator sets a plain URL in the environment and
 * Stripe starts rejecting the session for a malformed redirect.
 */

/**
 * Returns `url` with `key=value` added to its query string, whether or not it
 * already had one. Replaces the parameter if it is already present, so calling
 * this twice can't produce a URL with two copies of the same key.
 *
 * Throws on an unparseable URL rather than returning something malformed — a
 * bad redirect target is an operator misconfiguration, and failing loudly at
 * the point of use is what makes it findable.
 */
export function withQueryParam(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}
