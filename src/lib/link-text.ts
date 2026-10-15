/**
 * Web addresses in user-written text: finding them as typed, storing them as
 * short-link tokens, and turning those back into something to show and tap.
 *
 * WHY SHORT LINKS. Every address someone writes is stored once in
 * `short_links` and shown as `SHORT_LINK_URL/<code>` — in production
 * `https://www.kinkane.app/s/<code>` — the way LinkedIn shows
 * `lnkd.in/…`. A tap goes through our redirect, so an address found to be
 * phishing or spam can be switched off in one place and stops working in every
 * post that carries it. The text holds a token, `{{l:<id>}}`, for the same
 * reason mentions do (lib/mention-text.ts): what a link *shows as* is decided
 * at read time, not frozen into the text.
 *
 * Clients never see a token. They send plain text with addresses in it and get
 * back plain text with short links in it, plus a `links` array saying where
 * each one sits and where it goes. Sending a short link back — an edit that
 * leaves the link alone — maps to the same token, so editing round-trips.
 *
 * Offsets are UTF-16 code units, as for mentions.
 *
 * Nothing here touches the database or the config; the service hands in what
 * resolved, the prefix and our own hosts. That keeps every rule below pinned by unit tests.
 */

/** One linked address in rendered text. */
export interface LinkRef {
  /** The short link to open: counts the tap and honours a block. */
  url: string;
  /** Where it goes. Null when the link has been blocked. */
  target: string | null;
  /** The target's host without a leading `www.`, for a label or preview. Null when blocked. */
  domain: string | null;
  /** True when an admin has switched the link off; the short link then opens a "removed" page. */
  blocked: boolean;
  /** Index of the link's first character, in UTF-16 code units. */
  start: number;
  /** Length of the short link as it appears in the text. */
  length: number;
}

/** What the renderer needs to know about one stored link. */
export interface StoredLink {
  code: string;
  url: string;
  blocked: boolean;
}

/** An address found in typed text. */
export interface FoundUrl {
  /** Index of its first character in the text. */
  start: number;
  /** Length as typed, after trailing punctuation was left out. */
  length: number;
  /** The normalised address — what would be stored. */
  url: string;
}

/**
 * The most distinct addresses one piece of text may link. Beyond this the extra
 * addresses stay as typed, plain text: each one is a row in `short_links`, and
 * a comment that is mostly addresses is spam whatever its intent.
 */
export const MAX_LINKS_PER_TEXT = 5;

/** Longer addresses are left as plain text rather than stored. */
export const MAX_URL_LENGTH = 2048;

/** How a token whose row cannot be found reads. Unreachable while rows are never deleted. */
export const MISSING_LINK = '[link removed]';

// `{{l:123}}` — the stored form.
const TOKEN_RE = /\{\{l:(\d+)\}\}/g;

// A typed address: `http://`, `https://` or `www.` at a word boundary, up to
// whitespace or a character that cannot sit in an address unencoded and
// usually wraps one: `<`, `>`, `"`, the curly double quotes and guillemets
// phone keyboards type in place of `"`, an ellipsis, or an emoji. Without
// those, `“https://x.com/a”` or `https://x.com/a🔥` would store the quote or
// emoji as part of the address and send readers to a page that doesn't exist.
// Trailing punctuation is trimmed after.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"\u201C\u201D\u201E\u00AB\u00BB\u2039\u203A\u2026\p{Extended_Pictographic}]+/giu;

// ASCII sentence punctuation, curly single quotes (typed for `'`), and the
// full-width punctuation CJK keyboards use.
const TRAILING_PUNCTUATION = /[.,;:!?'*\u2018\u2019\u3001\u3002\uFF01\uFF0C\uFF1A\uFF1B\uFF1F\uFF09]+$/u;
const BRACKETS: [string, string][] = [['(', ')'], ['[', ']'], ['{', '}']];

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/**
 * The address minus what belongs to the sentence around it: "see
 * https://x.com/a." ends at `a`, and "(https://x.com/a)" loses its closing
 * bracket — but a bracket the address opened itself
 * (`https://en.wikipedia.org/wiki/Dune_(novel)`) is kept.
 */
function trimTrailing(raw: string): string {
  let s = raw;
  for (;;) {
    const before = s;
    s = s.replace(TRAILING_PUNCTUATION, '');
    for (const [open, close] of BRACKETS) {
      if (s.endsWith(close) && count(s, close) > count(s, open)) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

/**
 * The address as it would be stored, or null when it is not one worth linking:
 * not http(s), no dotted host, too long, or carrying a user name — an address
 * like `https://bank.com@evil.example` reads as the bank and goes to the other.
 */
export function normalizeUrl(raw: string): string | null {
  const withScheme = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  if (parsed.href.length > MAX_URL_LENGTH) return null;
  return parsed.href;
}

/**
 * Breaks any token-shaped text the user typed themselves, so a literal
 * `{{l:5}}` can never render as somebody else's link. Same trick as mentions.
 */
export function neutralizeLinkTokens(text: string): string {
  return text.replace(/\{\{l:/g, '{{ l:');
}

/**
 * Every linkable address typed in `text`, in order.
 *
 * With `ownHosts`, our own short links are always found, even on a host
 * normalizeUrl would refuse (`localhost:3000` in development): an edit sends
 * them back, and they must map to the link they already are.
 */
export function findUrls(text: string, ownHosts: readonly string[] = []): FoundUrl[] {
  const found: FoundUrl[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const trimmed = trimTrailing(match[0]);
    const url = normalizeUrl(trimmed) ?? (shortLinkCode(trimmed, ownHosts) ? trimmed : null);
    if (url) found.push({ start: match.index!, length: trimmed.length, url });
  }
  return found;
}

/**
 * Where every address-shaped run of text sits, `[start, end)`, whether or not
 * it was linked — one past the per-text cap, one too long to store. An `@`
 * inside any of them is part of an address, never a mention.
 */
export function addressSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(URL_RE)) {
    spans.push([match.index!, match.index! + trimTrailing(match[0]).length]);
  }
  return spans;
}

/** `www.kinkane.app` and `kinkane.app` are the same site. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * The code of one of our own short links, uppercased, or null for any other
 * address. How a short link sent back in an edit is recognised.
 *
 * Ours means: on one of `ownHosts` (with or without `www.`), at `/s/<code>` —
 * the current form — or `/l/<code>`, the form links were first shown in.
 * Accepting both keeps an edit of an older post, or a link pasted from one,
 * pointing at the link it already is.
 */
export function shortLinkCode(url: string, ownHosts: readonly string[]): string | null {
  if (ownHosts.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^www\./i.test(url) ? `https://${url}` : url);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash) return null;
  if (!ownHosts.some((h) => bareHost(h) === bareHost(parsed.host))) return null;
  const m = /^\/[ls]\/([A-Za-z0-9]{4,16})\/?$/.exec(parsed.pathname);
  return m ? m[1].toUpperCase() : null;
}

/** `<prefix>/<code>` — the form every link is shown as, e.g. `https://www.kinkane.app/s/7KQ2M9XA`. */
export function shortLinkUrl(prefix: string, code: string): string {
  return `${prefix.replace(/\/+$/, '')}/${code}`;
}

/**
 * Rewrites typed addresses into tokens.
 *
 * `idFor` maps a found address to its `short_links` id, or undefined when it
 * did not resolve (an unknown short-link code); those stay as typed. Only the
 * first MAX_LINKS_PER_TEXT distinct links are tokenised.
 *
 * Expects text already passed through neutralizeLinkTokens.
 */
export function tokenizeLinks(
  text: string,
  found: FoundUrl[],
  idFor: (f: FoundUrl) => number | undefined,
): { text: string; linkIds: number[] } {
  const linked: number[] = [];
  let out = '';
  let last = 0;
  for (const f of found) {
    const id = idFor(f);
    if (id === undefined) continue;
    if (!linked.includes(id)) {
      if (linked.length >= MAX_LINKS_PER_TEXT) continue;
      linked.push(id);
    }
    out += text.slice(last, f.start) + `{{l:${id}}}`;
    last = f.start + f.length;
  }
  out += text.slice(last);
  return { text: out, linkIds: linked };
}

/**
 * How long `text` will read once each link token is shown as a short link of
 * `shortLinkLength` characters. Mention tokens are counted as stored.
 */
export function shownLength(text: string, shortLinkLength: number): number {
  let length = text.length;
  for (const match of text.matchAll(TOKEN_RE)) length += shortLinkLength - match[0].length;
  return length;
}

/** Every link id tokenised into `text`. */
export function linkTokenIds(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(TOKEN_RE)) ids.add(Number(match[1]));
  return [...ids];
}

/** Cheap pre-check, so text with no links never costs a lookup. */
export function hasLinkTokens(text: string | null | undefined): boolean {
  return !!text && text.includes('{{l:');
}

/** A replacement made while rendering: at `at` in the input, the text grew by `delta`. */
export interface Shift {
  at: number;
  delta: number;
}

/**
 * Turns stored link tokens into short links, with the position of each.
 *
 * Also returns where the text changed length, so offsets computed on the input
 * — the mention offsets, when mentions were rendered first — can be moved to
 * match the output with `shiftOffsets`.
 */
export function renderLinks(
  text: string,
  linksById: ReadonlyMap<number, StoredLink>,
  prefix: string,
): { text: string; links: LinkRef[]; shifts: Shift[] } {
  const links: LinkRef[] = [];
  const shifts: Shift[] = [];
  let out = '';
  let last = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const at = match.index!;
    out += text.slice(last, at);
    const link = linksById.get(Number(match[1]));
    let shown: string;
    if (link) {
      shown = shortLinkUrl(prefix, link.code);
      links.push({
        url: shown,
        target: link.blocked ? null : link.url,
        domain: link.blocked ? null : domainOf(link.url),
        blocked: link.blocked,
        start: out.length,
        length: shown.length,
      });
    } else {
      shown = MISSING_LINK;
    }
    out += shown;
    shifts.push({ at, delta: shown.length - match[0].length });
    last = at + match[0].length;
  }
  out += text.slice(last);

  return { text: out, links, shifts };
}

/** Moves offsets taken before renderLinks to where the same characters sit after it. */
export function shiftOffsets<T extends { start: number }>(items: T[], shifts: Shift[]): T[] {
  if (shifts.length === 0) return items;
  return items.map((item) => {
    let delta = 0;
    for (const s of shifts) if (s.at < item.start) delta += s.delta;
    return delta ? { ...item, start: item.start + delta } : item;
  });
}

/**
 * A domain as the block list stores it: lowercased, punycode, no leading
 * `www.`. Null for anything that isn't a dotted host name.
 */
export function normalizeDomain(raw: string): string | null {
  let host: string;
  try {
    host = new URL(`https://${raw.trim()}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/**
 * Every block-list entry that would cover `url`: its host and each parent
 * domain, so blocking `evil.example` also covers `login.evil.example`.
 * Single labels (`example`, a bare TLD) are left out.
 */
export function domainCandidates(url: string): string[] {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** `www.example.com` → `example.com`. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
