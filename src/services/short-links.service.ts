import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { blockedLinkDomains, shortLinks } from '../db/schema';
import { config } from '../config';
import {
  MAX_LINKS_PER_TEXT,
  domainCandidates,
  findUrls,
  neutralizeLinkTokens,
  shortLinkCode,
  shortLinkUrl,
  shownLength,
  tokenizeLinks,
  type FoundUrl,
  type StoredLink,
} from '../lib/link-text';
import { randomCode } from '../lib/random-code';

/**
 * Short links, the part that needs the database: storing the addresses people
 * write, looking them up to render, following them, and switching them off.
 * The text rules live in lib/link-text.ts.
 */

/** 32^8 ≈ 10^12 codes: walking them to find links in private posts is not practical behind the rate limit. */
const CODE_LENGTH = 8;

/** What every short link is shown under: SHORT_LINK_URL, or APP_URL/l when unset. */
export function shortLinkPrefix(): string {
  return config.shortLinkUrl;
}

/** How many characters every short link takes up in rendered text. */
export function shortLinkLength(): number {
  return shortLinkUrl(shortLinkPrefix(), 'X'.repeat(CODE_LENGTH)).length;
}

/**
 * Refuses text that will read longer than `maxLength` once its link tokens are
 * shown as short links — the limit an edit sending it back will be held to.
 */
function assertFits(tokenized: string, maxLength: number | undefined): void {
  if (maxLength === undefined) return;
  const linkLength = shortLinkLength();
  if (shownLength(tokenized, linkLength) > maxLength) {
    throw Object.assign(
      new Error(`This is too long once links are shortened. Keep it to ${maxLength} characters, counting each link as ${linkLength}.`),
      { statusCode: 400, code: 'TEXT_TOO_LONG' },
    );
  }
}

/** Hosts whose `/s/<code>` and `/l/<code>` links are ours, so an edit that sends one back keeps the same link. */
export function ownShortLinkHosts(): string[] {
  return [config.shortLinkUrl, config.appUrl].map((u) => new URL(u).host);
}

/**
 * Ids for these addresses, creating rows for any not seen before. One insert
 * for all of them; ON CONFLICT DO NOTHING covers an address someone else
 * stored concurrently and the (practically impossible) code collision, which
 * is simply retried with fresh codes.
 */
async function idsForUrls(urls: string[], authorId: number | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let missing = [...new Set(urls)];
  for (let attempt = 0; missing.length > 0 && attempt < 3; attempt++) {
    await db
      .insert(shortLinks)
      .values(missing.map((url) => ({ url, code: randomCode(CODE_LENGTH), createdBy: authorId })))
      .onConflictDoNothing();
    const rows = await db
      .select({ id: shortLinks.id, url: shortLinks.url })
      .from(shortLinks)
      .where(inArray(shortLinks.url, missing));
    for (const r of rows) out.set(r.url, r.id);
    missing = missing.filter((u) => !out.has(u));
  }
  if (missing.length > 0) throw new Error('Could not store short links');
  return out;
}

/**
 * Which of these addresses sit on a blocked domain (or a subdomain of one).
 * One query however many addresses; none when there are none.
 */
async function onBlockedDomains(urls: string[]): Promise<Set<string>> {
  const candidatesByUrl = new Map(urls.map((u) => [u, domainCandidates(u)]));
  const all = [...new Set([...candidatesByUrl.values()].flat())];
  if (all.length === 0) return new Set();
  const rows = await db
    .select({ domain: blockedLinkDomains.domain })
    .from(blockedLinkDomains)
    .where(inArray(blockedLinkDomains.domain, all));
  const blocked = new Set(rows.map((r) => r.domain));
  return new Set(urls.filter((u) => candidatesByUrl.get(u)!.some((d) => blocked.has(d))));
}

async function idsForCodes(codes: string[]): Promise<Map<string, number>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ id: shortLinks.id, code: shortLinks.code })
    .from(shortLinks)
    .where(inArray(shortLinks.code, [...new Set(codes)]));
  return new Map(rows.map((r) => [r.code, r.id]));
}

export const shortLinksService = {
  /**
   * Prepares user-typed text for storage: every address becomes a short-link
   * token. A short link of ours sent back unchanged (an edit) maps to the link
   * it already is; one with an unknown code stays as typed text.
   */
  async prepare(text: string, authorId: number | null, maxLength?: number): Promise<{ text: string; linkIds: number[] }> {
    const safe = neutralizeLinkTokens(text);
    const hosts = ownShortLinkHosts();
    const found = findUrls(safe, hosts);
    if (found.length === 0) {
      assertFits(safe, maxLength);
      return { text: safe, linkIds: [] };
    }

    const codeOf = new Map(found.map((f) => [f, shortLinkCode(f.url, hosts)]));
    const keyOf = (f: FoundUrl) => codeOf.get(f) ?? f.url;

    // Measured on a dry run with stand-in ids, so text that is too long once
    // its links are shortened is refused before any row is written.
    if (maxLength !== undefined) {
      const standIn = new Map<string, number>();
      const dry = tokenizeLinks(safe, found, (f) => {
        const key = keyOf(f);
        if (!standIn.has(key)) standIn.set(key, standIn.size + 1);
        return standIn.get(key);
      });
      assertFits(dry.text, maxLength);
    }
    const external = found.filter((f) => codeOf.get(f) === null);
    const ownCodes = found.map((f) => codeOf.get(f)).filter((c): c is string => c !== null);

    // Only MAX_LINKS_PER_TEXT distinct addresses are linked anyway; storing
    // rows for more than a margin over that would let one comment fill the
    // table with addresses that never render as links.
    const toStore = [...new Set(external.map((f) => f.url))].slice(0, MAX_LINKS_PER_TEXT * 2);
    const [byUrl, byCode] = await Promise.all([idsForUrls(toStore, authorId), idsForCodes(ownCodes)]);

    return tokenizeLinks(safe, found, (f) => {
      const code = codeOf.get(f);
      return code ? byCode.get(code) : byUrl.get(f.url);
    });
  },

  /**
   * What the renderer needs for each of these ids. Ids with no row are absent.
   * A link is blocked when it was blocked itself or its domain is.
   */
  async load(ids: number[]): Promise<Map<number, StoredLink>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: shortLinks.id, code: shortLinks.code, url: shortLinks.url, blockedAt: shortLinks.blockedAt })
      .from(shortLinks)
      .where(inArray(shortLinks.id, ids));
    const domainBlocked = await onBlockedDomains(rows.map((r) => r.url));
    return new Map(
      rows.map((r) => [r.id, { code: r.code, url: r.url, blocked: r.blockedAt !== null || domainBlocked.has(r.url) }]),
    );
  },

  /**
   * A tap on a short link: where to send the reader, or that it is blocked
   * (itself or by domain). Null for an unknown code. Only taps that are
   * forwarded are counted.
   */
  async follow(code: string): Promise<{ url: string } | { blocked: true } | null> {
    const [row] = await db
      .select({ id: shortLinks.id, url: shortLinks.url, blockedAt: shortLinks.blockedAt })
      .from(shortLinks)
      .where(eq(shortLinks.code, code.toUpperCase()))
      .limit(1);
    if (!row) return null;
    if (row.blockedAt !== null || (await onBlockedDomains([row.url])).size > 0) return { blocked: true };

    await db
      .update(shortLinks)
      .set({ clickCount: sql`${shortLinks.clickCount} + 1` })
      .where(eq(shortLinks.id, row.id));
    return { url: row.url };
  },

  /** Admin: every blocked domain, newest first. */
  async listBlockedDomains() {
    return db.select().from(blockedLinkDomains).orderBy(sql`${blockedLinkDomains.blockedAt} DESC`);
  },

  /** Admin: blocks every link on `domain` and its subdomains. Idempotent; a repeat updates the reason. */
  async blockDomain(domain: string, reason: string | null) {
    const [row] = await db
      .insert(blockedLinkDomains)
      .values({ domain, reason })
      .onConflictDoUpdate({ target: blockedLinkDomains.domain, set: { reason } })
      .returning();
    return row;
  },

  /** Admin: lifts a domain block. False when the domain wasn't blocked. */
  async unblockDomain(domain: string): Promise<boolean> {
    const rows = await db.delete(blockedLinkDomains).where(eq(blockedLinkDomains.domain, domain)).returning();
    return rows.length > 0;
  },

  /** Admin: everything stored about one link. */
  async get(code: string) {
    const [row] = await db.select().from(shortLinks).where(eq(shortLinks.code, code.toUpperCase())).limit(1);
    return row ?? null;
  },

  /** Admin: switches a link off (or back on) everywhere it appears. Null for an unknown code. */
  async setBlocked(code: string, blocked: boolean, reason: string | null) {
    const [row] = await db
      .update(shortLinks)
      .set(blocked ? { blockedAt: sql`COALESCE(${shortLinks.blockedAt}, now())`, blockedReason: reason } : { blockedAt: null, blockedReason: null })
      .where(eq(shortLinks.code, code.toUpperCase()))
      .returning();
    return row ?? null;
  },
};
