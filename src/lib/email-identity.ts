/**
 * "Is this the same person?" for promotions — deliberately not for anything else.
 *
 * A first-order discount keyed on the raw email is free money to anyone who can
 * type `rachel+2@gmail.com`. This collapses the aliasing tricks that cost
 * nothing to use, so that abusing the promotion takes real work (a new mailbox)
 * rather than a keystroke.
 *
 * It is a **heuristic about mailbox aliasing, not an identity**. Two different
 * people can normalise to the same string at a provider that treats `+` or `.`
 * literally, and the same person can trivially get two normalised forms with
 * two real mailboxes. So it is safe to use for "should this order get a
 * promotional discount", and unsafe for anything where being wrong matters:
 * never authenticate, deduplicate accounts, or merge order history on it.
 */

/** Providers that ignore dots in the local part entirely. */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Lower-cases, drops any `+tag`, and drops dots at the providers that ignore
 * them. Anything that does not look like an address comes back lower-cased and
 * otherwise untouched — this is a normaliser, not a validator, and the caller
 * has already validated.
 *
 * `+` tagging is stripped for every domain rather than a known list. Most
 * providers that support tagging use `+`, and the ones that treat it literally
 * are rare enough that the trade — occasionally denying a second discount to
 * someone with an unusual address — is the right way round for a promotion.
 */
export function normalizeEmailForPromotions(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  // A local part that is *only* a tag (`+tag@…`) would normalise to empty and
  // collide with every other such address, so that case keeps its local part.

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replace(/\./g, '');

  return `${local}@${domain}`;
}
