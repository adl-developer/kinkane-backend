/**
 * How a book's genres are shown in API responses.
 *
 * Thema subject headings are hierarchical, and the hierarchy is written into the
 * name with colons: "Literary studies: poetry and poets", "Children’s / Teenage
 * general interest: Ball games and sports: Cricket". A book card only wants the
 * top level, so responses carry the part before the first colon.
 *
 * Display only. The stored name is untouched — the recommendation engine and
 * reader-type prompts read the full heading — and so is the slug, which is what
 * `?genre=` filters on: tapping "Literary studies" still filters by the exact
 * genre it came from.
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
 * Adds a genre to a book's list in display form, skipping it when the list
 * already shows that name. Several stored genres collapse to one top level —
 * "Literary studies: general" and "Literary studies: poetry and poets" — and a
 * card showing "Literary studies" twice is a bug, not information. The first
 * genre seen keeps its slug.
 */
export function addDisplayGenre<T extends GenreRef>(list: T[], genre: GenreRef): void {
  const name = genreDisplayName(genre.name);
  const key = name.toLowerCase();
  if (list.some((existing) => existing.name.toLowerCase() === key)) return;
  list.push({ name, slug: genre.slug } as T);
}

/** A whole list at once, for callers that already hold every genre of one book. */
export function toDisplayGenres(genres: GenreRef[]): GenreRef[] {
  const out: GenreRef[] = [];
  for (const genre of genres) addDisplayGenre(out, genre);
  return out;
}
