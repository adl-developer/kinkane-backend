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
