/**
 * Parses a Gardners I12 `.HDD` dispatch file. See EDI_docs/I12 FTP Home
 * Delivery Specification.pdf pages 17-19.
 *
 * Structurally simpler than the .ACK: a HEADER, one DETAIL per dispatched
 * *item*, a TRAILER, and no error records — a dispatch file only ever reports
 * things that happened.
 *
 * What is *not* simple is the last four fields. DETAIL1-4 are, in the
 * specification's own words, "an English description of the dispatch method",
 * which may also carry "the shipper parcel/reference number and/or Recorded
 * Delivery number along with a Contact Name/Telephone number". There is no
 * field for the carrier, none for the tracking URL and none for the tracking
 * number — all three have to be recovered from prose written for a human.
 *
 * So the extraction below is deliberately built to degrade rather than guess:
 * every field it produces is independently optional, an unrecognised phrasing
 * yields null instead of a wrong value, and the four raw lines are always kept
 * so an operator can read what Gardners actually said. A null tracking number
 * shows the customer "dispatched, no tracking yet", which is true; a *wrong*
 * one sends them to someone else's parcel.
 */
import { parseCsvLine } from './csv';

export interface HddDispatchLine {
  /** Gardners' dispatch number. Items shipped together share one. */
  dispatchNo: string;
  /** Our `gardners_dropship_order_lines.id`, as sent in the .ORD. The join key. */
  uniqueReference: string;
  additionalReference: string | null;
  batchRef: string | null;
  gardnersRef: string | null;
  /**
   * The ISBN actually supplied — **not necessarily the one ordered.** The spec
   * is explicit that an out-of-print ISBN may be slipped to a new edition, so
   * this is recorded rather than used to match the line.
   */
  isbn13: string;
  /** Quantity on *this* dispatch. A line can ship across several. */
  quantity: number;
  /** Dispatch date, ISO `YYYY-MM-DD`, or null if unparseable. */
  dispatchedOn: string | null;
  pricePence: number | null;
  deliveryPence: number | null;
  /** Discount in basis points as Gardners sends it (4400 = 44.00%). */
  discountBasisPoints: number | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** DETAIL1-4 exactly as received, empty entries dropped. */
  descriptionLines: string[];
}

export interface HddParseResult {
  accountCode: string | null;
  /** File creation date, ISO `YYYY-MM-DD`, or null. */
  fileDate: string | null;
  lines: HddDispatchLine[];
  trailerCount: number | null;
  raw: string;
}

/** Gardners writes dates as DD/MM/YYYY throughout the I12 files. */
function toIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function toIntOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The carrier name.
 *
 * Two phrasings are known from the specification's own example:
 * `"Dispatched Royal Mail 48 Tracked"` and `"Contact Royal Mail On:"`. The
 * second is preferred — it names the carrier and nothing else, where the first
 * mixes in the service level ("48 Tracked"), which is not the carrier.
 *
 * Falls back to the whole of DETAIL1 minus the "Dispatched " prefix, because a
 * slightly-too-long carrier string is still useful to a customer, where null is
 * not.
 */
export function extractCarrier(descriptionLines: string[]): string | null {
  for (const line of descriptionLines) {
    const contact = /^\s*contact\s+(.+?)\s+on\b/i.exec(line);
    if (contact) return contact[1].trim() || null;
  }

  const first = descriptionLines[0];
  if (!first) return null;

  const dispatched = /^\s*dispatched\s+(.+)$/i.exec(first);
  const value = (dispatched ? dispatched[1] : first).trim();
  return value || null;
}

/**
 * The tracking number.
 *
 * Anchored on an explicit label rather than on the *shape* of the value. It is
 * tempting to reach for something like `/[A-Z]{2}\d{9}GB/` — Royal Mail's
 * format — but Gardners uses many carriers, and a shape-matcher that does not
 * recognise a new one silently returns null while a too-loose one happily
 * matches a phone number out of the "Contact ... On:" line. The label is what
 * actually carries the meaning.
 */
export function extractTrackingNumber(descriptionLines: string[]): string | null {
  for (const line of descriptionLines) {
    const match =
      /(?:tracking|consignment|parcel|reference|recorded\s+delivery)\s*(?:number|no\.?|ref\.?)?\s*[:#]\s*(\S+)/i.exec(
        line,
      );
    if (match) {
      const value = match[1].trim().replace(/[.,;]+$/, '');
      if (value) return value;
    }
  }
  return null;
}

/**
 * The tracking URL, normalised to an absolute `https://` link.
 *
 * Gardners writes it bare (`www.royalmail.com/track-your-item`), and
 * `orders.tracking_url` is rendered as a link — a bare host stored as-is
 * resolves relative to our own domain and 404s. Anything that already carries a
 * scheme keeps it, but only http/https: the column ends up in an `href`, so a
 * `javascript:` payload arriving in supplier prose must not survive the trip.
 */
export function extractTrackingUrl(descriptionLines: string[]): string | null {
  for (const line of descriptionLines) {
    const match = /(https?:\/\/\S+|www\.\S+)/i.exec(line);
    if (!match) continue;

    let url = match[1].trim().replace(/[.,;)]+$/, '');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (!parsed.hostname.includes('.')) continue;
      return parsed.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Field order, from the specification's example DETAIL record:
 *
 *   "DETAIL", DISPATCHNO, UNIQUEREF, ADDREF, BATCHREF, GARDNERSREF, ISBN,
 *   QTY, DATE, PRICE, DELIVERY, DISCOUNT, DETAIL1, DETAIL2, DETAIL3, DETAIL4
 */
function toDispatchLine(tokens: string[]): HddDispatchLine | null {
  const uniqueReference = (tokens[2] ?? '').trim();
  const isbn13 = (tokens[6] ?? '').trim();

  // Without a unique reference there is no way to attribute the dispatch to an
  // order line, which makes the record unusable. Dropped rather than guessed —
  // attaching tracking to the wrong customer is the one outcome worth failing
  // the whole record to avoid.
  if (!uniqueReference) return null;

  const descriptionLines = tokens
    .slice(12, 16)
    .map((line) => (line ?? '').trim())
    .filter((line) => line.length > 0);

  return {
    dispatchNo: (tokens[1] ?? '').trim(),
    uniqueReference,
    additionalReference: (tokens[3] ?? '').trim() || null,
    batchRef: (tokens[4] ?? '').trim() || null,
    gardnersRef: (tokens[5] ?? '').trim() && tokens[5] !== '0' ? tokens[5].trim() : null,
    isbn13,
    quantity: toIntOrNull(tokens[7]) ?? 0,
    dispatchedOn: toIsoDate(tokens[8]),
    pricePence: toIntOrNull(tokens[9]),
    deliveryPence: toIntOrNull(tokens[10]),
    discountBasisPoints: toIntOrNull(tokens[11]),
    carrier: extractCarrier(descriptionLines),
    trackingNumber: extractTrackingNumber(descriptionLines),
    trackingUrl: extractTrackingUrl(descriptionLines),
    descriptionLines,
  };
}

export function parseHddFile(raw: string): HddParseResult {
  const rawLines = raw
    .split(/\r\n|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const result: HddParseResult = {
    accountCode: null,
    fileDate: null,
    lines: [],
    trailerCount: null,
    raw,
  };

  for (const line of rawLines) {
    const tokens = parseCsvLine(line);

    switch (tokens[0]) {
      case 'HEADER':
        result.accountCode = (tokens[1] ?? '').trim() || null;
        result.fileDate = toIsoDate(tokens[2]);
        break;

      case 'DETAIL': {
        const dispatch = toDispatchLine(tokens);
        if (dispatch) result.lines.push(dispatch);
        break;
      }

      case 'TRAILER':
        result.trailerCount = toIntOrNull(tokens[1]);
        break;

      // Anything else is skipped rather than thrown on. The raw file is kept
      // on every dispatch row this produces, so an unrecognised shape is
      // recoverable by hand instead of costing us the rest of the file.
      default:
        break;
    }
  }

  return result;
}
