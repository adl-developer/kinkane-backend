/**
 * CSV for the admin console's export buttons.
 *
 * Hand-rolled rather than a dependency because the whole job is quoting, and
 * the one rule that matters is not the RFC — it is that a spreadsheet must not
 * execute what it opens.
 */

/**
 * Escapes one field.
 *
 * Two separate concerns:
 *
 * 1. **CSV correctness** — anything containing a comma, quote or newline is
 *    wrapped in quotes, and embedded quotes are doubled.
 * 2. **Formula injection** — a field starting with `=`, `+`, `-`, `@`, tab or
 *    carriage return is treated as a formula by Excel, Sheets and Numbers. A
 *    customer whose name is `=HYPERLINK(...)` would otherwise get that executed
 *    on an operator's machine when they open the export. Prefixing an
 *    apostrophe neutralises it and is what the spreadsheet then displays.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One row, already escaped, CRLF-terminated as the format expects. */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',') + '\r\n';
}

/**
 * A whole document, header first.
 *
 * Prefixed with a UTF-8 BOM: without it Excel on Windows reads the file as
 * the local codepage, and every non-ASCII customer name in the export arrives
 * mojibake.
 */
export function csvDocument(header: string[], rows: unknown[][]): string {
  return '﻿' + csvRow(header) + rows.map(csvRow).join('');
}
