import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { shortLinks } from '../db/schema';
import { config } from '../config';
import {
  MAX_LINKS_PER_TEXT,
  findUrls,
  neutralizeLinkTokens,
  shortLinkCode,
  tokenizeLinks,
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
  async prepare(text: string, authorId: number | null): Promise<{ text: string; linkIds: number[] }> {
    const safe = neutralizeLinkTokens(text);
    const hosts = ownShortLinkHosts();
    const found = findUrls(safe, hosts);
    if (found.length === 0) return { text: safe, linkIds: [] };

    const codeOf = new Map(found.map((f) => [f, shortLinkCode(f.url, hosts)]));
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

  /** What the renderer needs for each of these ids. Ids with no row are absent. */
  async load(ids: number[]): Promise<Map<number, StoredLink>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: shortLinks.id, code: shortLinks.code, url: shortLinks.url, blockedAt: shortLinks.blockedAt })
      .from(shortLinks)
      .where(inArray(shortLinks.id, ids));
    return new Map(rows.map((r) => [r.id, { code: r.code, url: r.url, blocked: r.blockedAt !== null }]));
  },

  /**
   * A tap on a short link: counts it and says where to send the reader. Null
   * for an unknown code. A blocked link is not counted.
   */
  async follow(code: string): Promise<{ url: string; blocked: boolean } | null> {
    const normalized = code.toUpperCase();
    const [counted] = await db
      .update(shortLinks)
      .set({ clickCount: sql`${shortLinks.clickCount} + 1` })
      .where(and(eq(shortLinks.code, normalized), sql`${shortLinks.blockedAt} IS NULL`))
      .returning({ url: shortLinks.url });
    if (counted) return { url: counted.url, blocked: false };

    const [blocked] = await db
      .select({ url: shortLinks.url })
      .from(shortLinks)
      .where(eq(shortLinks.code, normalized))
      .limit(1);
    return blocked ? { url: blocked.url, blocked: true } : null;
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
