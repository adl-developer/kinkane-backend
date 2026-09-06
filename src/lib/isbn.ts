/**
 * Recognising an ISBN typed into a plain search box.
 *
 * A shopper (or a bookseller reading off the back of a book) pastes the number
 * into the same `?q=` field they'd type a title into, and expects the book.
 * Sending that through the catalogue's text search is both wrong and slow: the
 * digits match no title, so the query walks the whole fuzzy ladder — trigram
 * similarity and then full-text — over a 1.9M-row table to return nothing.
 *
 * So `?q=` is sniffed for an ISBN *before* the search runs, and a hit is
 * rewritten into the exact `isbn` filter this endpoint already has, which is a
 * single probe of the unique index on books.isbn13. Nothing about the text
 * search path changes: a query that is not an ISBN never reaches this code's
 * output at all.
 */

/** ISBN-13 EAN check digit for the first 12 digits. */
function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * ISBN-10 → ISBN-13, or null when the ISBN-10 check digit doesn't verify.
 *
 * The checksum is enforced here and *not* on the 13-digit path, which looks
 * inconsistent and isn't. Thirteen digits beginning 978/979 are an ISBN and
 * nothing else, so a bad check digit there is a typo and an empty result is the
 * honest answer — and it keeps this in step with the `isbn` parameter, which
 * has never checksummed either. Ten digits are far more ambiguous (a year, an
 * order number, a phone number), so the checksum is what earns the right to
 * treat them as an ISBN at all; roughly nine in ten random 10-digit strings
 * fail it.
 */
function isbn10To13(isbn10: string): string | null {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = isbn10[i];
    const value = char === 'X' ? 10 : Number(char);
    // X is only ever the check digit.
    if (value === 10 && i !== 9) return null;
    sum += value * (10 - i);
  }
  if (sum % 11 !== 0) return null;

  const first12 = `978${isbn10.slice(0, 9)}`;
  return `${first12}${ean13CheckDigit(first12)}`;
}

/**
 * The ISBN-13 a search query is asking for, or null if it isn't asking for one.
 *
 * Accepts the number as it is printed — spaces and hyphens are separators, not
 * content — in either the 13-digit or the 10-digit form (converted, since the
 * catalogue only stores ISBN-13). Anything else, including a partial ISBN, is
 * not an ISBN lookup: a prefix of an ISBN identifies no book, so it stays a
 * text search rather than becoming an exact match that cannot hit.
 */
export function isbnFromQuery(q: string): string | null {
  const compact = q.trim().replace(/[\s-]/g, '').toUpperCase();

  if (/^\d{13}$/.test(compact)) return compact;
  if (/^\d{9}[\dX]$/.test(compact)) return isbn10To13(compact);
  return null;
}
