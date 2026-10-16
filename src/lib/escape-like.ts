/**
 * Escapes LIKE/ILIKE metacharacters in user-supplied text, so it matches
 * literally. Without it, q='_' matches every row and q='%' returns everything —
 * and `_` is also a legal username character, so a username search needs it to
 * mean an underscore.
 *
 * Backslash is Postgres's default LIKE escape character, so no ESCAPE clause is
 * needed where this is used.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Every character that stands in for an apostrophe in what people type and in what the
 * catalogue stores: the straight `'`, the curly `’` that iOS Smart Punctuation (on by
 * default) sends when someone types `'`, its opening twin `‘`, and the modifier letter `ʼ`.
 * The catalogue mixes them — most feed titles carry `'`, a minority carry `’` — so a
 * query cannot know which one the book it wants was stored with.
 */
const APOSTROPHE_CHARS = `'’‘ʼ`;
const APOSTROPHE = new RegExp(`[${APOSTROPHE_CHARS}]`, 'g');

/**
 * An apostrophe inside a word — "segi’s", "o’brien" — becomes LIKE's single-character
 * wildcard, so it matches whichever apostrophe the title was stored with. "Inside" means a
 * letter, digit or combining mark on both sides; the mark covers decomposed text, where
 * "ĩ’" arrives as "i", U+0303, "’".
 *
 * Any other apostrophe stays a literal `'`. One that stands alone would otherwise match
 * every row, the hole escapeLike closes for `_`. One that ends the query ("the’", "jones’")
 * would otherwise match any next character, so "the’" would mean "the" plus anything,
 * which is about a third of the catalogue.
 */
const WORD_APOSTROPHE = new RegExp(`(?<=[\\p{L}\\p{M}\\p{N}])[${APOSTROPHE_CHARS}](?=[\\p{L}\\p{M}\\p{N}])`, 'gu');

/** escapeLike, plus apostrophe folding — see WORD_APOSTROPHE. */
function escapeSearchText(value: string): string {
  return escapeLike(value).replace(WORD_APOSTROPHE, '_').replace(APOSTROPHE, "'");
}

/**
 * The query with every apostrophe written as `'` and again as `’`, for matchers that compare
 * whole tokens rather than patterns (full-text search), where a wildcard is not available.
 * A tsvector keeps the apostrophe it was built from — "Segi’s" indexes as `segi’` while
 * "Segi's" indexes as `segi` — so a search has to try both spellings. A query with no
 * apostrophe yields itself once.
 */
export function apostropheVariants(value: string): string[] {
  const straight = value.replace(APOSTROPHE, "'");
  const curly = value.replace(APOSTROPHE, '’');
  return straight === curly ? [value] : [straight, curly];
}

/**
 * The LIKE patterns search builds from what someone typed, escaped. Every search
 * that matches typed text with LIKE/ILIKE goes through these rather than
 * concatenating `%` itself — a hand-built `q + '%'` is how `%%%` came to match
 * every user, group, post and book.
 *
 * Typed text matches literally, with one exception: an apostrophe inside a word
 * matches any apostrophe (see WORD_APOSTROPHE).
 */

/** Starts with `value`. */
export function likePrefix(value: string): string {
  return escapeSearchText(value) + '%';
}

/** Has a word, after a space, that starts with `value`. */
export function likeWordPrefix(value: string): string {
  return '% ' + escapeSearchText(value) + '%';
}

/** Contains `value` anywhere. */
export function likeContains(value: string): string {
  return '%' + escapeSearchText(value) + '%';
}
