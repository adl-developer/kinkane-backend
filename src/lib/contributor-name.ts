/**
 * Contributor names arrive from the ONIX feeds with doubled internal spaces —
 * "Catherine  Eschle", "David  Peace", "Karl E.  Peace". At the time of writing that is
 * 27,428 of 126,664 contributor rows (21.7%), spanning 17,718 books, and more than half
 * of them are primary authors rather than editors, so it degrades ordinary author search
 * and not just the edited-volume case.
 *
 * The prefix tiers of name search compare with LIKE/ILIKE, which are literal: one space
 * typed against two spaces stored is simply not a match, and the trigram index does not
 * save it (the index only pre-filters — the recheck runs against the raw string). So the
 * name search matches a *normalised* form on both sides instead.
 *
 * Normalising the stored data rather than the comparison was the alternative, and was
 * rejected: the ingested value is a faithful record of what the supplier sent, and once
 * it is overwritten there is no way to tell a genuine name from a repaired one.
 */

/**
 * SQL expression that normalises a contributor-name column for comparison: collapses
 * every run of whitespace to a single space and trims the ends.
 *
 * Interpolated as raw SQL, so it takes a column expression rather than a bound
 * parameter — it has to appear verbatim in both the query and the index definition it
 * relies on (see db/setup.ts). An expression index is only usable when the query's
 * expression matches the index's *exactly*, so these two must come from here rather than
 * being written out twice. A one-character drift between them is not an error: it is a
 * silent fall back to a sequential scan over the whole contributor table.
 *
 * Note the doubled backslash. In a JavaScript string literal `'\s'` is not a recognised
 * escape, so it collapses to a bare `'s'` — which turns this expression into one that
 * strips the letter "s" out of every name. It fails quietly and produces plausible-looking
 * wrong matches; it is not a syntax error anywhere along the way. Hence the constant, and
 * hence the test that normalises a name containing an "s".
 */
export const normalisedNameSql = (column: string): string =>
  `btrim(regexp_replace(${column}, '\\s+', ' ', 'g'))`;

/** The column the name indexes and the name-match tiers are both built over. */
export const NORMALISED_PERSON_NAME = normalisedNameSql('person_name');

/**
 * The JavaScript-side counterpart, applied to the search term so both sides of the
 * comparison are normalised the same way. Must stay equivalent to normalisedNameSql:
 * the query is normalised here and the column is normalised in SQL, and a match depends
 * on the two agreeing.
 *
 * Idempotent, so it is safe to apply again to a term a caller has already cleaned.
 */
export function normaliseNameQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

/** Separator punctuation at either end of a query — see canonicalNameQuery. */
const EDGE_SEPARATORS = /^[\s.,;:'’()/-]+|[\s.,;:'’()/-]+$/g;

/**
 * The search term as name matching should see it: whitespace normalised as above, and
 * any separator punctuation trimmed off the ends. "barbara," is someone halfway through
 * typing "barbara, kingsolver", not a search for a name that literally starts with a
 * comma — left in, the prefix tiers looked for "barbara,%" and found only the one
 * malformed supplier name that happens to contain it.
 *
 * Only the ends. A comma or full stop inside the query is kept, because the in-order
 * tiers compare against stored names that have them ("Dr. Seuss", "J.R.R. Tolkien"),
 * and anything word-order-shaped is handled by the any-order match instead.
 *
 * Falls back to the whitespace-normalised term when trimming would leave nothing, so a
 * query of pure punctuation behaves exactly as it did rather than becoming a bare "%".
 */
export function canonicalNameQuery(q: string): string {
  const normalised = normaliseNameQuery(q);
  const trimmed = normalised.replace(EDGE_SEPARATORS, '');
  return trimmed.length > 0 ? trimmed : normalised;
}

/**
 * What separates the words of a name for any-order matching. Commas and full stops are
 * the ones that matter — "Shakespeare, William" and "J.R.R. Tolkien" — and hyphens and
 * apostrophes let "Haig Brown" and "Grady" reach "Haig-Brown" and "O'Grady".
 *
 * Spelled out rather than written as a POSIX class: the database's ctype is C, so
 * [[:alnum:]] would treat every accented letter as a separator and match mid-word.
 */
const NAME_WORD_START = `(^|[ .,'’()/-])`;

const SEPARATOR_RUN = /[\s.,;:'’()/-]+/;

/**
 * Splits a name query into the words that must each start a word of the matched name,
 * in any order. "Shakespeare, William", "William Shakespeare" and "shakespeare william"
 * all give the same two words; "Tolkien, J.R.R." gives tolkien, j and r, which is how it
 * reaches both "J.R.R. Tolkien" and "J. R. R. Tolkien".
 *
 * Lowercased and deduplicated — the comparison is case-insensitive and a repeated word
 * ("j r r") adds nothing but another predicate.
 */
export function nameSearchWords(q: string): string[] {
  const words = q.toLowerCase().split(SEPARATOR_RUN).filter((w) => w.length > 0);
  return [...new Set(words)];
}

/**
 * Regex matching `word` at the start of any word of a name — at the start of the
 * string or just after a separator. Used with ~*, which the trigram index serves.
 * Whitespace is only ever a single space by the time it is compared: the column side
 * goes through normalisedNameSql first.
 *
 * The word is escaped, so a query can't smuggle regex syntax in; separators never reach
 * here because nameSearchWords splits on them.
 */
export function nameWordStartPattern(word: string): string {
  return NAME_WORD_START + word.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Whether a query is worth the word-start match on top of the plain prefix ones.
 *
 * For two or more words it is what makes word order irrelevant. For a single word it
 * catches a name whose words are joined by punctuation rather than a space —
 * "J.Roderick Heller" for "roderick", "Smith,Barbara" for "barbara" — which the
 * space-anchored word-prefix match cannot see.
 *
 * Needs at least one word of three or more characters, because that is what gives the
 * trigram index something to look up; a query made only of initials ("j k") would
 * otherwise be a regex scan over every contributor row.
 */
export function wantsAnyOrderNameMatch(words: string[]): boolean {
  return words.some((w) => w.length >= 3);
}
