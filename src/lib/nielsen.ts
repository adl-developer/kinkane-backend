import { config } from '../config';

/**
 * Minimal client for the NielsenIQ BookData Online REST interface.
 *
 * The developer guide prints the base URL as http:// — the service 301s to
 * https, and both the client ID and password travel in the query string, so
 * we always start from https rather than let credentials make an unencrypted
 * first hop.
 */
const REVIEW_FIELDS = ['NBDFREV', 'AUSFREV', 'NZFREV'] as const;

/** Result codes from the developer guide, p8. */
const RESULT_COMPLETED = '00';
const RESULT_LIMITS_EXCEEDED = '50';

const REQUEST_TIMEOUT_MS = 20_000;

/** Nielsen reports the account's daily record allowance is spent. */
export class NielsenLimitExceededError extends Error {
  constructor() {
    super('Nielsen returned resultCode 50 (LIMITS_EXCEEDED)');
    this.name = 'NielsenLimitExceededError';
  }
}

export class NielsenRequestError extends Error {
  constructor(message: string, readonly resultCode?: string) {
    super(message);
    this.name = 'NielsenRequestError';
  }
}

export interface NielsenReview {
  reviewHtml: string;
  sourceField: string;
}

/**
 * Pulls a single element's text out of the response.
 *
 * A regex is safe here specifically because Nielsen entity-escapes field
 * values: the review text arrives as `&lt;p&gt;…`, never as raw markup, so a
 * value can never contain the closing tag we stop at. Anything that needs to
 * understand the record as a whole should use a real parser instead.
 */
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function buildUrl(isbn13: string): URL {
  const url = new URL(config.nielsen.baseUrl);
  url.searchParams.set('clientId', config.nielsen.clientId ?? '');
  url.searchParams.set('password', config.nielsen.password ?? '');
  url.searchParams.set('from', '0');
  url.searchParams.set('to', '1');
  url.searchParams.set('indexType', '0');
  // 7 = XML, the format the guide recommends for this interface.
  url.searchParams.set('format', '7');
  // Long view — the review field is absent from Short and Medium entirely.
  url.searchParams.set('resultView', '2');
  url.searchParams.set('territory', config.nielsen.territory);
  // Search field 1 = ISBN / EAN.
  url.searchParams.set('field0', '1');
  url.searchParams.set('value0', isbn13);
  return url;
}

/**
 * Looks up one ISBN and returns its review text, or null when Nielsen has a
 * record but no review for it (the common case — roughly 70% of titles).
 *
 * Throws NielsenLimitExceededError when the daily allowance is gone, which
 * callers should treat as "stop for today" rather than as a per-book failure.
 */
export async function fetchReviewByIsbn(isbn13: string): Promise<NielsenReview | null> {
  if (!config.nielsen.clientId || !config.nielsen.password) {
    throw new NielsenRequestError('Nielsen credentials are not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body: string;
  try {
    const response = await fetch(buildUrl(isbn13), { signal: controller.signal });
    if (!response.ok) {
      throw new NielsenRequestError(`Nielsen responded with HTTP ${response.status}`);
    }
    body = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const resultCode = extractTag(body, 'resultCode');

  if (resultCode === RESULT_LIMITS_EXCEEDED) {
    throw new NielsenLimitExceededError();
  }

  if (resultCode !== RESULT_COMPLETED) {
    throw new NielsenRequestError(
      `Nielsen returned resultCode ${resultCode ?? 'none'}`,
      resultCode ?? undefined,
    );
  }

  for (const field of REVIEW_FIELDS) {
    const raw = extractTag(body, field);
    if (!raw) continue;

    const text = decodeEntities(raw).trim();

    // Nielsen has two ways of saying "nothing here": omit the element, or
    // return this literal placeholder. Both mean the same thing to us.
    if (!text || text.toLowerCase().startsWith('no reviews available')) continue;

    return { reviewHtml: text, sourceField: field };
  }

  return null;
}
