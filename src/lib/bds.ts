import { config } from '../config';
import { redis } from './redis';

/**
 * Minimal client for the BDSLive Platform XML API (Bibliographic Data
 * Services). We use it for two fields Gardners' ONIX never carries: author
 * biographies and press review quotes.
 *
 * Written against the v2.1 API document and BDS's sample responses, before
 * we had credentials — the parts that could only be guessed from the docs are
 * flagged ASSUMPTION below and are exactly what scripts/bds-probe.ts checks
 * the first time it runs against the live service.
 */

const REQUEST_TIMEOUT_MS = 30_000;

// A year, per the API document. Cached for a little less so we never send a
// token in its final hours; a rejected token triggers a fresh login anyway.
const TOKEN_TTL_SECONDS = 360 * 24 * 60 * 60;
const TOKEN_CACHE_KEY = 'bds:api-token';

/**
 * Asking for only the fields we store keeps responses small — a full BDS
 * record carries dozens of fields we already get from Gardners.
 * `barcode` and `identifier` are here so a record can be matched back to the
 * ISBN we asked for.
 */
export const BDS_FIELDS = [
  'barcode',
  'identifier',
  'author_bio',
  'biographical_note',
  'review',
  'prizes',
  'related_editions',
  'index_updated',
] as const;

/** BDS's own name for "the token is missing, expired or revoked". */
const AUTH_ERROR_CODE = 1;

export class BdsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BdsAuthError';
  }
}

export class BdsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BdsRequestError';
  }
}

export interface BdsRecord {
  isbn13: string;
  /** Contributor biographies, as HTML (BDS field `author_bio`). */
  authorBio: string | null;
  /** The ONIX biographical note(s), when BDS carries them separately. */
  biographicalNotes: string[];
  /** Press review quotes, as HTML, outlet names embedded in the prose. */
  review: string | null;
  prizes: string | null;
  /** ISBNs of other editions of the same work. */
  relatedEditions: string[];
  /** yyyymmdd — when BDS last changed the record. */
  indexUpdated: string | null;
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Placeholders that mean "nothing here". The only one seen in BDS samples is
 * an empty CDATA block, which trimming already handles; Nielsen's literal
 * "No reviews available" is included because the two services share
 * publisher-supplied data and the check costs nothing.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === '' || v.startsWith('no reviews available') || v === 'n/a';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/**
 * A field's text. HTML fields arrive wrapped in CDATA (taken verbatim); plain
 * fields arrive entity-escaped (decoded). Handles both, and a mix.
 */
function fieldText(raw: string): string {
  const cdata = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (cdata.length > 0) return cdata.map((m) => m[1]).join('').trim();
  return decodeEntities(raw).trim();
}

/**
 * Every field of one record, repeated elements collected in order.
 *
 * ASSUMPTION: BDS have shown us two XML shapes — the live service's
 * `<resultfields>` records with `fv_`-prefixed element names, and the
 * integrator's guide's `<record>` with bare names. Both are accepted, and the
 * prefix is dropped, so the rest of the code only ever sees `author_bio`.
 *
 * A regex rather than a parser is safe here only because records are flat:
 * field values are CDATA or escaped text and never contain their own closing
 * tag. The one nested field BDS has (`contributor_list`) is films/music only.
 */
function parseFields(recordXml: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const re = /<(fv_)?([a-z0-9_]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1?\2>)/gi;
  for (const m of recordXml.matchAll(re)) {
    const name = m[2].toLowerCase();
    const value = m[3] === undefined ? '' : fieldText(m[3]);
    const list = fields.get(name) ?? [];
    list.push(value);
    fields.set(name, list);
  }
  return fields;
}

function first(fields: Map<string, string[]>, name: string): string | null {
  for (const value of fields.get(name) ?? []) {
    if (!isPlaceholder(value)) return value;
  }
  return null;
}

/** Repeated elements and pipe-separated lists both flattened to one list. */
function list(fields: Map<string, string[]>, name: string): string[] {
  return (fields.get(name) ?? [])
    .flatMap((v) => v.split('|'))
    .map((v) => v.trim())
    .filter((v) => !isPlaceholder(v));
}

const ISBN13 = /^97[89]\d{10}$/;

/**
 * Splits a response into records. Exported for the probe script and tests.
 * Records whose ISBN cannot be recovered are dropped — without one there is
 * nothing to attach the text to.
 */
export function parseRecords(xml: string): BdsRecord[] {
  const records: BdsRecord[] = [];
  for (const m of xml.matchAll(/<(resultfields|record)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const fields = parseFields(m[2]);

    const candidates = [...list(fields, 'barcode'), ...list(fields, 'isbn_13'), ...list(fields, 'identifier')];
    const isbn13 = candidates.find((c) => ISBN13.test(c));
    if (!isbn13) continue;

    records.push({
      isbn13,
      authorBio: first(fields, 'author_bio'),
      biographicalNotes: list(fields, 'biographical_note'),
      review: first(fields, 'review'),
      prizes: first(fields, 'prizes'),
      relatedEditions: list(fields, 'related_editions').filter((c) => ISBN13.test(c)),
      indexUpdated: first(fields, 'index_updated'),
    });
  }
  return records;
}

/**
 * BDS report errors as a JSON body — with HTTP 200, so the status code alone
 * says nothing. Seen live: `{"response":{"error_code":1,"error_msg":
 * "Unauthorised access! ...","explain":"No token or invalid token"}}`.
 */
function parseErrorBody(body: string): { code: number; message: string } | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const json = JSON.parse(trimmed) as { response?: { error_code?: number | string; error_msg?: string; explain?: string } };
    const r = json.response;
    if (!r || r.error_code === undefined || Number(r.error_code) === 0) return null;
    return {
      code: Number(r.error_code),
      message: [r.error_msg, r.explain].filter(Boolean).join(' — ') || 'unknown BDS error',
    };
  } catch {
    return null;
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

async function httpGet(url: URL, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new BdsRequestError(`BDS responded with HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

let memoryToken: string | null = null;

/**
 * Trades the account credentials for a bearer token. BDS's login takes them
 * in the query string (their design, not ours); https keeps them off the wire
 * but they may still reach BDS's access logs, so this account should not
 * share a password with anything else.
 */
async function login(): Promise<string> {
  const { username, password, baseUrl } = config.bds;
  if (!username || !password) throw new BdsAuthError('BDS credentials are not configured');

  const url = new URL(baseUrl);
  url.searchParams.set('sx', '_login');
  url.searchParams.set('usr', username);
  url.searchParams.set('pwd', password);

  const body = await httpGet(url, { 'Content-Type': 'application/json' });
  const error = parseErrorBody(body);
  if (error) throw new BdsAuthError(`BDS login failed: ${error.message}`);

  let token: string | undefined;
  try {
    token = (JSON.parse(body) as { response?: { token?: string } }).response?.token;
  } catch {
    // fall through to the error below
  }
  if (!token) throw new BdsAuthError('BDS login returned no token');

  memoryToken = token;
  // Shared through Redis so every process uses one token rather than each
  // worker logging in on its own.
  await redis.set(TOKEN_CACHE_KEY, token, 'EX', TOKEN_TTL_SECONDS).catch(() => undefined);
  return token;
}

async function getToken(): Promise<string> {
  if (memoryToken) return memoryToken;
  const cached = await redis.get(TOKEN_CACHE_KEY).catch(() => null);
  if (cached) {
    memoryToken = cached;
    return cached;
  }
  return login();
}

async function forgetToken(): Promise<void> {
  memoryToken = null;
  await redis.del(TOKEN_CACHE_KEY).catch(() => undefined);
}

/**
 * One authenticated GET. A rejected token is replaced and the request retried
 * once; a second rejection is a real credentials problem and is thrown.
 */
export async function bdsGet(params: Record<string, string>): Promise<string> {
  const url = new URL(config.bds.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await getToken();
    const body = await httpGet(url, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml',
    });

    const error = parseErrorBody(body);
    if (!error) return body;
    if (error.code === AUTH_ERROR_CODE && attempt === 1) {
      await forgetToken();
      continue;
    }
    if (error.code === AUTH_ERROR_CODE) throw new BdsAuthError(`BDS rejected a fresh token: ${error.message}`);
    throw new BdsRequestError(`BDS error ${error.code}: ${error.message}`);
  }
  // Unreachable: the loop either returns or throws.
  throw new BdsRequestError('BDS request failed');
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * The query for a batch of ISBNs.
 *
 * ASSUMPTION: BDS say up to 100 ISBNs per request but the document only
 * shows single-value lookups. The documented field-search syntax with an
 * explicit OR is the form most likely to work; the probe script verifies it
 * returns every ISBN it should.
 */
export function isbnQueryParams(isbns: string[], fields: readonly string[] = BDS_FIELDS): Record<string, string> {
  return {
    SF1: 'identifier',
    ST1: isbns.join(' OR '),
    PL: String(isbns.length),
    VIEW: 'xml',
    FIELDS: fields.join(','),
  };
}

/**
 * Looks up to 100 ISBNs in one call. The map has an entry for every ISBN
 * asked about: a record, or null when BDS returned nothing for it.
 */
export async function fetchByIsbns(isbns: string[]): Promise<Map<string, BdsRecord | null>> {
  if (isbns.length > 100) throw new BdsRequestError('BDS accepts at most 100 ISBNs per request');

  const result = new Map<string, BdsRecord | null>(isbns.map((i) => [i, null]));
  if (isbns.length === 0) return result;

  const body = await bdsGet(isbnQueryParams(isbns));
  for (const record of parseRecords(body)) {
    // BDS may hold several records for one ISBN; the first with any text wins.
    if (result.has(record.isbn13) && result.get(record.isbn13) === null) {
      result.set(record.isbn13, record);
    }
  }
  return result;
}

/**
 * One page of records BDS changed between two dates (yyyymmdd, inclusive).
 * `index_updated` is the field to use: the documented SINCE/DTSPAN operators
 * filter on publication date, not on when a record changed.
 */
export async function fetchUpdatedPage(
  fromYmd: string,
  toYmd: string,
  page: number,
  pageSize = 100,
): Promise<{ records: BdsRecord[]; rawCount: number }> {
  const body = await bdsGet({
    SF1: 'index_updated',
    ST1: `${fromYmd}:${toYmd}`,
    PL: String(pageSize),
    M: String(page * pageSize),
    VIEW: 'xml',
    FIELDS: BDS_FIELDS.join(','),
  });
  // rawCount, not records.length, decides whether there is another page:
  // records without an ISBN are dropped by the parser but still fill a page.
  const rawCount = [...body.matchAll(/<(resultfields|record)\b[^>]*>/gi)].length;
  return { records: parseRecords(body), rawCount };
}

/** Test hook: drop the in-process token so each test starts logged out. */
export function resetBdsTokenForTests(): void {
  memoryToken = null;
}
