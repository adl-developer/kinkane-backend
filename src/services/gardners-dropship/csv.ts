/**
 * Gardners' I12 order/ack files use a CSV dialect that's almost-but-not-quite
 * standard: comma-separated, CRLF line endings, double-quoted text fields,
 * bare (unquoted) numeric fields, and "" as the escape for a literal quote
 * inside a text field. Both directions (writing .ORD, reading .ACK) need the
 * exact same dialect, so both live here.
 */

export function quoteText(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function csvRow(...fields: string[]): string {
  return fields.join(',') + '\r\n';
}

/**
 * Quote-aware split of one CSV line into raw field tokens, with surrounding
 * quotes stripped and "" unescaped back to ". Gardners' ACK files mix quoted
 * text fields with bare numeric ones on the same line, so a plain `.split(',')`
 * would break the moment a text field is empty ("") or contains a comma.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;

  while (i <= n) {
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (line[i] === ',') i++;
      else break;
    } else {
      let value = '';
      while (i < n && line[i] !== ',') {
        value += line[i];
        i++;
      }
      fields.push(value);
      if (line[i] === ',') i++;
      else break;
    }
  }

  return fields;
}
