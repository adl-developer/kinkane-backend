/**
 * Deciding which contributor a BDS biography is about.
 *
 * BDS supply one biography per *book*, not per person, and carry no author
 * identifier. On a single-author book that blob is that author's biography;
 * on an edited collection it may cover three editors at once, or describe
 * somebody who is not in our contributor list at all.
 *
 * Attaching it to the wrong person is the failure this module exists to
 * prevent — it is the same mistake that ruled out building this from
 * Wikipedia, where name matching confidently returned a farmer, a biathlete
 * and a racing driver for authors of the same name.
 *
 * So the rule is deliberately narrow, and measured rather than assumed
 * (156 biographies fetched live, 2026-09-25):
 *
 *   - exactly one main author (A01) on the book — 93 of 156, and about 71%
 *     of the catalogue; and
 *   - the biography's text mentions that author's surname — true for 87 of
 *     those 93 (94%). The six that fail are precisely the cases where the
 *     blob is about a different person.
 *
 * Anything else keeps the biography at book level, where the reader sees it
 * next to the whole book rather than pinned to one name.
 */

/** ONIX contributor role for "author" — the only role a bio is attached to. */
const MAIN_AUTHOR_ROLE = 'A01';

/** Suffixes that are not part of a surname. */
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'i', 'ii', 'iii', 'iv', 'phd', 'ph.d.', 'md', 'mbe', 'obe', 'cbe']);

export type BioConfidence = 'high';

export interface ContributorLike {
  role: string | null;
  personName: string | null;
}

/**
 * Plain, comparable text from a BDS biography: tags removed, entities
 * loosened to spaces, accents folded, lowercased.
 *
 * Accent folding matters because the feeds disagree with each other about
 * them — "Bronte" in one record, "Brontë" in another — and a surname check
 * that fails on that would quietly drop biographies for every author with a
 * diacritic in their name.
 */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The surname to look for. Takes the last meaningful word of the display
 * name, ignoring honorific suffixes ("Martin Luther King Jr" → "king").
 *
 * Returns null for anything too short to be evidence: a two-letter token
 * matches inside ordinary words and would make the check meaningless.
 */
export function surnameOf(personName: string): string | null {
  const words = plainText(personName)
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NAME_SUFFIXES.has(w));

  const last = words[words.length - 1];
  if (!last || last.length < 3) return null;
  return last;
}

/** Whether the biography's text names this person. */
export function bioMentions(bioHtml: string, personName: string): boolean {
  const surname = surnameOf(personName);
  if (!surname) return false;
  // Word boundaries, so "Ford" does not match "Stafford". Escaped because a
  // name can legitimately contain regex characters (O'Brien, Saint-Exupéry).
  const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(plainText(bioHtml));
}

/**
 * The contributor a book-level biography can safely be attributed to, or null
 * when it cannot be attributed to anyone.
 *
 * Exported separately from the book-detail wiring so the author-level bio job
 * can apply exactly the same rule — the two must never drift, or an author
 * page would claim a biography the book page refuses to show.
 */
export function attributableContributor<T extends ContributorLike>(
  contributors: T[],
  bioHtml: string | null,
): { contributor: T; confidence: BioConfidence } | null {
  if (!bioHtml) return null;

  const authors = contributors.filter((c) => c.role === MAIN_AUTHOR_ROLE && c.personName);
  if (authors.length !== 1) return null;

  const author = authors[0];
  if (!bioMentions(bioHtml, author.personName!)) return null;

  // A biography that also names another contributor is about both of them —
  // seen live on manga, where one blob covers the writer and the illustrator,
  // and on books with a named translator or foreword author. Showing it under
  // one person's name would put someone else's life story there. Measured at
  // 43 of 1,047 attributions (4.1%), so refusing costs very little.
  const namesSomeoneElse = contributors.some(
    (c) => c !== author && c.personName && bioMentions(bioHtml, c.personName),
  );
  if (namesSomeoneElse) return null;

  return { contributor: author, confidence: 'high' };
}
