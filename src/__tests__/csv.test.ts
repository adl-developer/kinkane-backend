import { describe, it, expect } from 'vitest';
import { csvField, csvRow, csvDocument } from '../lib/csv';

// The admin export buttons hand a CSV to whatever spreadsheet the operator uses.
// The one property that matters more than RFC conformance is that the file
// cannot execute what it contains when opened.

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('Ama Boateng')).toBe('Ama Boateng');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes anything with a comma or newline', () => {
    expect(csvField('Accra, Ghana')).toBe('"Accra, Ghana"');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises a formula so a spreadsheet cannot execute a customer name', () => {
    // The whole point: a customer called =HYPERLINK(...) must not run on an
    // operator's machine. The apostrophe is what the spreadsheet then shows.
    // This one also contains quotes, so it is both prefixed AND CSV-quoted:
    // apostrophe, then doubled inner quotes, then wrapping quotes.
    expect(csvField('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvField('+1234')).toBe("'+1234");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes a formula that also contains a comma, and still prefixes it', () => {
    expect(csvField('=A1,B2')).toBe('"\'=A1,B2"');
  });

  it('renders null and undefined as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('csvDocument', () => {
  it('starts with a UTF-8 BOM so Excel reads non-ASCII correctly', () => {
    const doc = csvDocument(['Name'], [['Amélie']]);
    expect(doc.charCodeAt(0)).toBe(0xfeff);
  });

  it('CRLF-terminates every row', () => {
    const doc = csvDocument(['a', 'b'], [['1', '2']]);
    expect(doc).toBe('﻿a,b\r\n1,2\r\n');
  });
});
