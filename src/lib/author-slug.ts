/**
 * Turning an author's name into a URL segment.
 *
 * There is no authors table in this system — an "author" is a distinct
 * `person_name` across the contributor rows. So the slug *is* the identity, and
 * it has to be derived deterministically from the name every time.
 *
 * This function is mirrored **character for character** by
 * `idx_book_contributors_author_slug` in the contributors schema:
 *
 *   btrim(lower(regexp_replace(person_name, '[^a-zA-Z0-9]+', '-', 'g')), '-')
 *
 * Change one and you must change the other. If they drift, every author page
 * silently stops using the index and starts scanning the contributor table —
 * a failure that passes every test and only shows up under production load.
 * `author-slug.test.ts` pins the two together.
 *
 * **Accents are not stripped**, deliberately. Postgres can only fold them via
 * `unaccent()`, which is STABLE rather than IMMUTABLE and therefore illegal in
 * an index expression. Rather than have the two sides disagree, both treat an
 * accented character as a separator: `Adichié` slugs to `adichi`. Slightly
 * lossy, and identical on both sides — which is the property that matters,
 * because a slug that resolves is worth more than a slug that reads nicely.
 */

/** `Tayari Jones` → `tayari-jones`; `N. K. Jemisin` → `n-k-jemisin`. */
export function authorSlug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

/** Slugs are lowercase alphanumerics separated by single hyphens. */
export const AUTHOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
