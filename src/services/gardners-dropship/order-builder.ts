/**
 * Builds the raw .ORD file content for Gardners' I12 Home Delivery ordering
 * interface. Field order and quoting within each DETAIL's home-delivery
 * block follows the layout in the spec's own examples byte-for-byte (see
 * EDI_docs/I12 FTP Home Delivery Specification.pdf, pages 6-8) — Gardners'
 * parser is a legacy fixed-format reader, not a tolerant one, so this isn't
 * a place to "clean up" field ordering.
 */
import { csvRow, quoteText } from './csv';

export interface RecipientAddress {
  titleName?: string; // Mr/Mrs/Miss etc, max 10 chars
  initials?: string; // max 3 chars
  name: string; // surname, max 35 chars
  addr1: string; // max 35 chars
  addr2?: string;
  addr3?: string;
  addr4?: string;
  postcode?: string; // max 8 chars
  country: string; // MUST match the I12d Gardners country list exactly
}

export interface OrderLineInput {
  uniqueReference: string; // 9-digit zero-padded, e.g. "000000123"
  additionalReference: string; // max 15 chars
  isbn13: string;
  quantity: number;
  gardnersRefToQuote?: number; // pre-allocated stock ref; 0 unless Gardners issued one
  invoice: RecipientAddress;
  delivery: RecipientAddress | null; // null => Gardners uses invoice address
  priceGbpPence: number;
  deliveryGbpPence: number;
  serviceCode: string; // 3-digit, e.g. "011"
  giftwrap?: boolean; // spec: not currently available, must stay false
  signature?: boolean;
  tracking: boolean;
  trackingEmail: string; // mandatory per spec regardless of `tracking`
  trackingSms?: string | null;
  trackingSafePlace?: string | null;
  batchRef?: string | null;
  maxWaitDays: number; // 1-90
  comm1?: string | null;
  comm2?: string | null;
  comm3?: string | null;
  comm4?: string | null;
}

export interface OrderFileInput {
  accountCode: string;
  orderDate: Date;
  testing: boolean;
  sequence: string; // HEADER SEQUENCE — unique across every order ever sent
  lines: OrderLineInput[];
}

function formatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function addressRows(prefix: 'I' | 'D', addr: RecipientAddress | null): string {
  // Oddity in the spec (and confirmed against a real accepted order in
  // EDI_docs/000000043.ORD): the invoice group's title/initials tags are
  // bare TITLENAME/INITIALS with no "I" prefix, while every other invoice
  // field and the entire delivery group (including DTITLENAME/DINITIALS)
  // do carry their letter prefix. Not a typo to "clean up".
  const titleTag = prefix === 'I' ? 'TITLENAME' : 'DTITLENAME';
  const initialsTag = prefix === 'I' ? 'INITIALS' : 'DINITIALS';

  if (!addr) {
    // Blank DADDR1 (and leaving the rest blank) tells Gardners to reuse the
    // invoice address for delivery — only meaningful for the D-prefixed group.
    return (
      csvRow(quoteText(titleTag), quoteText('')) +
      csvRow(quoteText(initialsTag), quoteText('')) +
      csvRow(quoteText(`${prefix}NAME`), quoteText('')) +
      csvRow(quoteText(`${prefix}ADDR1`), quoteText('')) +
      csvRow(quoteText(`${prefix}ADDR2`), quoteText('')) +
      csvRow(quoteText(`${prefix}ADDR3`), quoteText('')) +
      csvRow(quoteText(`${prefix}ADDR4`), quoteText('')) +
      csvRow(quoteText(`${prefix}PCODE`), quoteText('')) +
      csvRow(quoteText(`${prefix}COUNTRY`), quoteText(''))
    );
  }
  return (
    csvRow(quoteText(titleTag), quoteText(addr.titleName ?? '')) +
    csvRow(quoteText(initialsTag), quoteText(addr.initials ?? '')) +
    csvRow(quoteText(`${prefix}NAME`), quoteText(addr.name)) +
    csvRow(quoteText(`${prefix}ADDR1`), quoteText(addr.addr1)) +
    csvRow(quoteText(`${prefix}ADDR2`), quoteText(addr.addr2 ?? '')) +
    csvRow(quoteText(`${prefix}ADDR3`), quoteText(addr.addr3 ?? '')) +
    csvRow(quoteText(`${prefix}ADDR4`), quoteText(addr.addr4 ?? '')) +
    csvRow(quoteText(`${prefix}PCODE`), quoteText(addr.postcode ?? '')) +
    csvRow(quoteText(`${prefix}COUNTRY`), quoteText(addr.country))
  );
}

function buildDetailLine(line: OrderLineInput): string {
  let out = csvRow(
    quoteText('DETAIL'),
    line.uniqueReference,
    quoteText(line.additionalReference),
    quoteText(line.isbn13),
    String(line.quantity),
    String(line.gardnersRefToQuote ?? 0),
  );

  out += addressRows('I', line.invoice);
  out += addressRows('D', line.delivery);

  out += csvRow(quoteText('PRICE'), String(line.priceGbpPence));
  out += csvRow(quoteText('DELIVERY'), String(line.deliveryGbpPence));
  out += csvRow(quoteText('SERVICE'), line.serviceCode.padStart(3, '0'));
  out += csvRow(quoteText('GIFTWRAP'), quoteText(line.giftwrap ? 'Y' : 'N'));
  out += csvRow(quoteText('SIGNATURE'), quoteText(line.signature ? 'Y' : 'N'));
  out += csvRow(quoteText('TRACKING'), quoteText(line.tracking ? 'Y' : 'N'));
  out += csvRow(quoteText('TRACKINGEMAIL'), quoteText(line.trackingEmail));
  out += csvRow(quoteText('TRACKINGSMS'), quoteText(line.trackingSms ?? ''));
  out += csvRow(quoteText('TRACKINGSAFEPLACE'), quoteText(line.trackingSafePlace ?? ''));
  out += csvRow(quoteText('BATCHREF'), quoteText(line.batchRef ?? ''));
  out += csvRow(quoteText('MAXWAIT'), String(line.maxWaitDays));
  out += csvRow(quoteText('COMM1'), quoteText(line.comm1 ?? ''));
  out += csvRow(quoteText('COMM2'), quoteText(line.comm2 ?? ''));
  out += csvRow(quoteText('COMM3'), quoteText(line.comm3 ?? ''));
  out += csvRow(quoteText('COMM4'), quoteText(line.comm4 ?? ''));

  return out;
}

export function buildOrderFile(input: OrderFileInput): string {
  let out = csvRow(
    quoteText('HEADER'),
    quoteText(input.accountCode),
    quoteText(formatDate(input.orderDate)),
    quoteText(input.testing ? 'Y' : 'N'),
    quoteText(input.sequence),
  );

  for (const line of input.lines) {
    out += buildDetailLine(line);
  }

  out += csvRow(quoteText('TRAILER'), String(input.lines.length).padStart(6, '0'));

  return out;
}
