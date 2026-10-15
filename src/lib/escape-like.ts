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
 * The LIKE patterns search builds from what someone typed, escaped. Every search
 * that matches typed text with LIKE/ILIKE goes through these rather than
 * concatenating `%` itself — a hand-built `q + '%'` is how `%%%` came to match
 * every user, group, post and book.
 */

/** Starts with `value`. */
export function likePrefix(value: string): string {
  return escapeLike(value) + '%';
}

/** Has a word, after a space, that starts with `value`. */
export function likeWordPrefix(value: string): string {
  return '% ' + escapeLike(value) + '%';
}

/** Contains `value` anywhere. */
export function likeContains(value: string): string {
  return '%' + escapeLike(value) + '%';
}
