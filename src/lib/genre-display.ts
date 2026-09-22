/**
 * How a book's genres are shown in API responses.
 *
 * Thema subject headings are hierarchical, and the hierarchy is written into the
 * name with colons: "Literary studies: poetry and poets", "Children’s / Teenage
 * general interest: Ball games and sports: Cricket". A book card only wants the
 * top level, so responses carry the part before the first colon.
 *
 * Display only. The stored name and slug are untouched — the recommendation
 * engine and reader-type prompts read the full heading. What a response carries
 * is the *family* slug: the top-level name slugified the same way the ingester
 * slugifies a full heading, so "Literary studies: poetry and poets" is shown as
 * { name: "Literary studies", slug: "literary_studies" }. `?genre=` resolves a
 * family slug to every genre under that top level (see genreIdsForSlug),
 * and a genre's original full slug still filters to exactly that genre.
 */

export interface GenreRef {
  name: string;
  slug: string;
}

/** "Literary studies: poetry and poets" → "Literary studies". Names without a colon are returned trimmed. */
export function genreDisplayName(name: string): string {
  const head = name.split(':', 1)[0].trim();
  // A name that starts with a colon has no top level to show; keep it whole
  // rather than return an empty chip.
  return head || name.trim();
}

/**
 * The ingester's slugify (onix_ingester chunk.worker), which is how every stored
 * genre slug was made. Mirrored rather than improved: a heading with no colon
 * is its own top level, and its family slug has to equal the slug it was stored
 * under or `?genre=` on that slug would stop matching the genre itself.
 */
export function slugifyGenreName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 200);
}

/**
 * The slug for a genre's whole top-level family. Falls back to the genre's own
 * slug when the top level has nothing slug-safe in it, so the result is never empty.
 */
export function genreFamilySlug(genre: GenreRef): string {
  return slugifyGenreName(genreDisplayName(genre.name)) || genre.slug;
}

/**
 * Adds a genre to a list in display form, skipping it when the list already
 * holds that family. Several stored genres collapse to one top level —
 * "Literary studies: general" and "Literary studies: poetry and poets" — and a
 * card showing "Literary studies" twice is a bug, not information. The entry
 * carries the family slug, so tapping it filters by the whole top level.
 *
 * Deduped on the family slug rather than the name, so two headings that differ
 * only in case or punctuation ("Children's" / "Children’s") — which filter
 * identically — are one entry. The first one seen keeps its spelling.
 */
export function addDisplayGenre<T extends GenreRef>(list: T[], genre: GenreRef): void {
  const slug = genreFamilySlug(genre);
  if (list.some((existing) => existing.slug === slug)) return;
  list.push({ name: genreDisplayName(genre.name), slug } as T);
}

/** A whole list at once, for callers that already hold every genre of one book. */
export function toDisplayGenres(genres: GenreRef[]): GenreRef[] {
  const out: GenreRef[] = [];
  for (const genre of genres) addDisplayGenre(out, genre);
  return out;
}

/**
 * One entry per top-level genre, the same entries book responses carry: a name
 * like "Literary studies" and its family slug, which `?genre=` expands to every
 * stored genre under that top level. `id` is the first stored genre of the
 * family in the order given — kept for older clients that read it, but it names one
 * genre, not the family, so filter on `slug`.
 */
export function toTopLevelGenres(rows: (GenreRef & { id: number })[]): (GenreRef & { id: number })[] {
  const seen = new Set<string>();
  const out: (GenreRef & { id: number })[] = [];
  for (const row of rows) {
    const slug = genreFamilySlug(row);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ id: row.id, name: genreDisplayName(row.name), slug });
  }
  // Re-sorted on the shortened name. Rows arrive in full-heading order, where
  // "Educational: …" sorts after "Educational systems" (a colon after a space),
  // so the order they arrive in is not alphabetical once the tails are gone.
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/**
 * Every stored genre id a `?genre=` value stands for: the whole family when it
 * is a family slug, and the one genre when it is a stored slug — so slugs saved
 * by clients before genres were shortened keep filtering exactly as they did.
 * Empty for a slug that matches nothing, which filters to no books, as before.
 */
export function genreIdsForSlug(rows: (GenreRef & { id: number })[], slug: string): number[] {
  return rows.filter((row) => row.slug === slug || genreFamilySlug(row) === slug).map((row) => row.id);
}
