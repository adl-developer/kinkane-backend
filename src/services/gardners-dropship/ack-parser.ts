/**
 * Parses a Gardners I12 .ACK file into a structured result. See EDI_docs/I12
 * FTP Home Delivery Specification.pdf pages 13-16 for the field semantics and
 * every documented error shape this handles.
 *
 * This is a best-effort parser against a legacy, loosely-specified format —
 * callers should always keep the raw ACK text alongside the parsed result
 * (gardnersDropshipOrders.rawAck) so nothing is lost if a real-world response
 * hits a shape this doesn't recognize.
 */
import { parseCsvLine } from './csv';

export interface AckFieldError {
  field: string;
  value: string;
  message: string;
}

export interface AckLineResult {
  uniqueReference: string;
  additionalReference: string;
  isbn13: string;
  quantity: number;
  gardnersRef: string | null; // null => rejected, not recorded at Gardners
  quantitySupplied: number | null;
  report: string | null;
  reportDate: string | null;
  rejected: boolean;
  fieldErrors: AckFieldError[];
}

export interface AckParseResult {
  accountCode: string | null;
  sequence: string | null;
  // Whole file rejected — no DETAIL lines were processed at all (bad
  // HEADER/TRAILER, or a duplicate SEQUENCE).
  headerRejected: boolean;
  headerErrorMessage: string | null;
  duplicate: boolean;
  lines: AckLineResult[];
  trailerCount: number | null;
  raw: string;
}

function isMessageLine(rawLine: string): boolean {
  return /^"<.*>"$/.test(rawLine.trim());
}

function stripMessage(rawLine: string): string {
  const trimmed = rawLine.trim();
  return trimmed.slice(2, -2);
}

function toDetailResult(tokens: string[], forcedRejected: boolean): AckLineResult {
  const rawGardnersRef = tokens[5];
  const gardnersRef = rawGardnersRef && rawGardnersRef !== '0' ? rawGardnersRef : null;
  const quantitySupplied = tokens[6] !== undefined && tokens[6] !== '' ? Number(tokens[6]) : null;
  const report = tokens[7] || null;

  return {
    uniqueReference: tokens[1] ?? '',
    additionalReference: tokens[2] ?? '',
    isbn13: tokens[3] ?? '',
    quantity: Number(tokens[4]) || 0,
    gardnersRef,
    quantitySupplied,
    report,
    reportDate: tokens[8] || null,
    rejected: forcedRejected || gardnersRef === null || report === 'N/A',
    fieldErrors: [],
  };
}

export function parseAckFile(raw: string): AckParseResult {
  const rawLines = raw
    .split(/\r\n|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result: AckParseResult = {
    accountCode: null,
    sequence: null,
    headerRejected: false,
    headerErrorMessage: null,
    duplicate: false,
    lines: [],
    trailerCount: null,
    raw,
  };

  let currentLine: AckLineResult | null = null;
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const tokens = parseCsvLine(line);
    const tag = tokens[0];

    if (tag === 'HEADER') {
      result.accountCode = tokens[1] ?? null;
      result.sequence = tokens[4] ?? null;
      i++;
      continue;
    }

    if (tag === 'ERROR') {
      const second = tokens[1];

      // Whole-file rejection: bad HEADER/TRAILER, or a duplicate SEQUENCE.
      // Every documented example of this shape echoes "HEADER" as the
      // second token, even the duplicate-order case.
      if (second === 'HEADER') {
        result.headerRejected = true;
        const next = rawLines[i + 1];
        if (next && isMessageLine(next)) {
          result.headerErrorMessage = stripMessage(next);
          result.duplicate = /duplicate/i.test(result.headerErrorMessage ?? '');
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      // Field-level error attached to the immediately preceding DETAIL line,
      // e.g. `"ERROR","SERVICE",070`.
      if (tokens.length <= 3 && currentLine) {
        const next = rawLines[i + 1];
        const message = next && isMessageLine(next) ? stripMessage(next) : '';
        currentLine.fieldErrors.push({ field: second ?? '', value: tokens[2] ?? '', message });
        currentLine.rejected = true;
        i += next && isMessageLine(next) ? 2 : 1;
        continue;
      }

      // Invalid record type / invalid ISBN — ERROR replaces DETAIL as the
      // first token but the rest of the line is detail-shaped.
      const detail = toDetailResult(tokens, true);
      const next = rawLines[i + 1];
      if (next && isMessageLine(next)) {
        detail.fieldErrors.push({ field: 'RECORD', value: '', message: stripMessage(next) });
        i += 2;
      } else {
        i++;
      }
      result.lines.push(detail);
      currentLine = detail;
      continue;
    }

    if (tag === 'DETAIL') {
      const detail = toDetailResult(tokens, false);
      result.lines.push(detail);
      currentLine = detail;
      i++;
      continue;
    }

    if (tag === 'TRAILER') {
      result.trailerCount = Number(tokens[1]) || 0;
      i++;
      continue;
    }

    // Unrecognized line shape (e.g. a stray message line not consumed by the
    // branches above) — skip rather than throw, the raw text is preserved
    // on the order row regardless.
    i++;
  }

  return result;
}
