/**
 * Mentions in user-written text: parsing what was typed, storing it in a form
 * that survives renames, and turning it back into something to show.
 *
 * WHY TOKENS. A mention is typed as `@ama_reads`, but it is about a *person*,
 * not a string. Stored as typed, it breaks the day Ama renames to `ama.reads`:
 * the old text points at nobody, or worse, at whoever claims `ama_reads` next.
 * So on the way in, every handle that names a real account is rewritten to a
 * token carrying the account's id — `@{{u:123}}` — and on the way out each
 * token is rendered as that account's username *as it is now*. The same idea as
 * the `{{name}}` token recommendation explanations are cached with.
 *
 * Clients never see a token. They send plain text with `@username` in it and
 * get back plain text with `@username` in it, plus a `mentions` array of where
 * each linked handle sits — so editing a post round-trips cleanly: what the
 * client was shown is exactly what it sends back.
 *
 * Offsets are UTF-16 code units, i.e. JavaScript string indices. That is also
 * what Dart's String and Swift's NSString/NSRange index by, so a client can
 * slice with them directly.
 *
 * Nothing here touches the database; the service resolves usernames and ids and
 * hands the maps in. That keeps every rule below pinned by plain unit tests.
 */

import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, checkUsernameFormat } from './username';

/** One linked handle in rendered text. */
export interface MentionRef {
  userId: number;
  username: string;
  /** Index of the `@`, in UTF-16 code units. */
  start: number;
  /** Length including the `@`. */
  length: number;
}

export interface RenderedText {
  text: string;
  mentions: MentionRef[];
}

/** How a deleted account's mention reads. `deleted` is a reserved username, so it cannot be anybody's. */
export const DELETED_MENTION = '@deleted';

/**
 * The most distinct people one piece of text may mention. Beyond this the
 * extra handles stay as plain text: a comment that @-mentions forty strangers
 * is spam whatever its intent, and each mention can end in a push notification.
 */
export const MAX_MENTIONS_PER_TEXT = 20;

// `@{{u:123}}` — the stored form.
const TOKEN_RE = /@\{\{u:(\d+)\}\}/g;

// A typed handle: `@` then the username alphabet. The character before the `@`
// is checked separately (see isHandleBoundary) rather than with a lookbehind,
// which keeps this readable.
const HANDLE_RE = /@([A-Za-z0-9_.]+)/g;

/**
 * Whether an `@` preceded by `prev` starts a mention. Not when it follows a
 * letter, digit or one of the handle characters: that is an email address
 * (`ama@example.com`) or the tail of something else, not someone being named.
 */
function isHandleBoundary(prev: string | undefined): boolean {
  return prev === undefined || !/[A-Za-z0-9_.@]/.test(prev);
}

/**
 * A typed handle, minus the trailing dots that belong to the sentence rather
 * than the name ("thanks @ama." → `ama`), lowercased — or null when what is
 * left cannot be a username at all.
 */
function cleanHandle(raw: string): { handle: string; consumed: number } | null {
  const trimmed = raw.replace(/\.+$/, '');
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) return null;
  const handle = trimmed.toLowerCase();
  // Reserved names are still well-formed handles, and nobody holds them, so the
  // lookup simply finds no one; only shape is checked here.
  const problem = checkUsernameFormat(handle);
  if (problem === 'invalid_format') return null;
  return { handle, consumed: trimmed.length };
}

/**
 * Every distinct username typed in `text`, lowercased, in order of first
 * appearance. What the service looks up before calling `tokenize`.
 */
export function extractHandles(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(HANDLE_RE)) {
    if (!isHandleBoundary(text[match.index! - 1])) continue;
    const cleaned = cleanHandle(match[1]);
    if (cleaned) seen.add(cleaned.handle);
  }
  return [...seen];
}

/**
 * Breaks any token-shaped text the user typed themselves, so a literal
 * `@{{u:5}}` in a comment can never render as a link to account 5 without
 * having been through the lookup (and the notification) that a real mention
 * gets. The space is the smallest change that stops TOKEN_RE matching.
 */
function neutralizeTokens(text: string): string {
  return text.replace(/\{\{u:/g, '{{ u:');
}

/**
 * Rewrites typed handles that name an account into tokens.
 *
 * `idsByUsername` holds only the usernames that resolved; anything else — a
 * typo, a reserved word, a name nobody holds — is left exactly as typed. Only
 * the first MAX_MENTIONS_PER_TEXT distinct people are linked.
 *
 * Returns the text to store and the ids it mentions, deduplicated, in order.
 */
export function tokenize(
  text: string,
  idsByUsername: ReadonlyMap<string, number>,
): { text: string; mentionedIds: number[] } {
  const safe = neutralizeTokens(text);
  const linked: number[] = [];

  let out = '';
  let last = 0;
  for (const match of safe.matchAll(HANDLE_RE)) {
    const at = match.index!;
    if (!isHandleBoundary(safe[at - 1])) continue;
    const cleaned = cleanHandle(match[1]);
    if (!cleaned) continue;
    const id = idsByUsername.get(cleaned.handle);
    if (id === undefined) continue;

    if (!linked.includes(id)) {
      if (linked.length >= MAX_MENTIONS_PER_TEXT) continue;
      linked.push(id);
    }

    out += safe.slice(last, at) + `@{{u:${id}}}`;
    // Only the handle itself is replaced; trailing sentence dots stay as text.
    last = at + 1 + cleaned.consumed;
  }
  out += safe.slice(last);

  return { text: out, mentionedIds: linked };
}

/** Every account id tokenized into `text`. */
export function tokenIds(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(TOKEN_RE)) ids.add(Number(match[1]));
  return [...ids];
}

/** Cheap pre-check, so text with no mentions never costs a lookup. */
export function hasTokens(text: string | null | undefined): boolean {
  return !!text && text.includes('@{{u:');
}

/**
 * Turns stored text back into what a reader sees, with the position of every
 * linked handle.
 *
 * `usernamesById` should carry every id in the text that still has an account
 * with a username. An id missing from it is a deleted account and renders as
 * DELETED_MENTION, unlinked — the sentence still reads, and nobody new can
 * inherit the mention.
 */
export function render(text: string, usernamesById: ReadonlyMap<number, string>): RenderedText {
  const mentions: MentionRef[] = [];
  let out = '';
  let last = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    out += text.slice(last, match.index!);
    const id = Number(match[1]);
    const username = usernamesById.get(id);
    if (username) {
      const handle = `@${username}`;
      mentions.push({ userId: id, username, start: out.length, length: handle.length });
      out += handle;
    } else {
      out += DELETED_MENTION;
    }
    last = match.index! + match[0].length;
  }
  out += text.slice(last);

  return { text: out, mentions };
}
