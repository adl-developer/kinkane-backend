/**
 * Splitting a search query into "the part that names a book" and "the part that names a
 * person".
 *
 * A reader typing into one box does not separate the two. "half of a yellow sun adichie"
 * and "rowling harry potter" are ordinary queries, and neither side of the catalogue can
 * answer them alone: the whole string is not a title prefix and it is not a contributor
 * name either. Before this existed they fell past both cheap tiers and were answered by
 * the fuzzy title pool, which is both the slowest query the search can issue and, for this
 * shape of query, the wrong answer — it returns near-misses on a string that was never
 * meant to be one title.
 *
 * This module is only the *candidate generation* half, and it is deliberately pure: given
 * a query it proposes the ways the tokens could be divided. Which candidate is right is
 * decided in SQL against the catalogue, per book, not here — see buildSplitMatchSource in
 * books.service.ts. Guessing here would mean guessing without evidence.
 */

/**
 * Only contiguous divisions are considered, and only ones that put the name at one end:
 * `[name][title]` or `[title][name]`. That is not a simplification of some more general
 * scheme — it is what people type. A name broken around a title ("chimamanda half of a
 * yellow sun adichie") is rare enough that covering it would cost every ordinary query a
 * wider candidate set for a case almost nobody hits.
 */
export interface SplitCandidate {
  /** The contiguous run of tokens being proposed as a person's name. */
  nameTokens: string[];
  /** Everything else, in query order — proposed as words from the title. */
  titleTokens: string[];
  /**
   * The subset of `titleTokens` actually worth looking for in a title.
   *
   * Stopwords and one-character tokens are dropped, because as a substring test they are
   * nearly always true: `title ILIKE '%a%'` matches almost the whole catalogue, so counting
   * it as evidence would score every book by the right author identically and leave the
   * ranking to the alphabet. For "half of a yellow sun adichie" this is `half yellow sun`,
   * which the real book matches completely and an unrelated book by the same author matches
   * not at all.
   *
   * Falls back to `titleTokens` when that would leave nothing — a query whose title half is
   * all stopwords is weak evidence, but it is the only evidence there is, and an empty list
   * would make every candidate score zero and be discarded.
   */
  titleMatchTokens: string[];
  /** The name run as one space-joined string, ready to be matched as a name prefix. */
  name: string;
  /** Which end the name run was taken from. Carried for logging and tests, not for ranking. */
  position: 'leading' | 'trailing';
}

/**
 * Queries longer than this are not split at all.
 *
 * A long query is either a full title (which the title tiers already answer) or pasted
 * text, and neither benefits. The cap matters because candidate count drives arm count in
 * the probe, and arm count is what keeps that query bounded.
 */
const MAX_QUERY_TOKENS = 8;

/**
 * Longest run of tokens that will be proposed as one person's name.
 *
 * Three covers the overwhelming majority of how names appear in the catalogue — "Chimamanda
 * Ngozi Adichie", "Ngũgĩ wa Thiong'o", "J. K. Rowling" once the initials are tokenised.
 * Four-part names exist, but every extra length adds two more candidates (one per end) for
 * a case the shorter runs usually still reach: a prefix arm on "chimamanda ngozi" matches
 * the same contributor row that "chimamanda ngozi adichie" does.
 */
const MAX_NAME_TOKENS = 3;

/**
 * Hard ceiling on candidates handed to the probe, whatever the query.
 *
 * The probe issues two index arms per candidate, so this is what bounds its width. Ordered
 * generation (below) means the ones dropped are the least likely to be names.
 */
const MAX_CANDIDATES = 6;

/**
 * Words that are never, alone, evidence of a person.
 *
 * A single-token run of one of these is dropped outright: "of" matching some contributor
 * whose name begins "Of..." is noise, and it would drag an arm's worth of unrelated books
 * into the candidate pool for every query containing the word. In a multi-token run they
 * are allowed, because a run is only dropped when it is *entirely* stopwords — "de la" is
 * not a name, but the run has to contain something else to be worth probing either way.
 *
 * Deliberately short and closed. This is not a linguistic stopword list; it is the set of
 * tokens that appear in ordinary book titles often enough to be a liability, and every
 * addition removes a real name from reach. "Green", "Gray", "King" and "Wolf" are all
 * common title words and all real surnames, so none of them are here.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'by', 'with', 'from', 'is', 'it', 'as', 'that', 'this', 'my', 'his',
  'her', 'their', 'its', 'book', 'books', 'novel',
]);

/**
 * Shortest single-token run that will be proposed as a name.
 *
 * A one- or two-character token is an initial or a fragment, and as a *prefix* match it is
 * close to unbounded — "j" is a prefix of a large slice of the contributor table. Multi-token
 * runs are exempt: "j k rowling" is bounded by its later tokens.
 */
const MIN_SOLO_NAME_CHARS = 3;

/** Splits on whitespace, dropping empties. Case is preserved; the SQL side folds it. */
function tokenise(q: string): string[] {
  return q.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The title words worth testing against a title — see SplitCandidate.titleMatchTokens.
 */
function titleMatchTokensFor(titleTokens: string[]): string[] {
  const useful = titleTokens.filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
  return useful.length > 0 ? useful : titleTokens;
}

/** A run is worth probing when it is not made entirely of stopwords, and is not a bare initial. */
function isPlausibleName(run: string[]): boolean {
  if (run.length === 1) {
    const only = run[0]!.toLowerCase();
    return only.length >= MIN_SOLO_NAME_CHARS && !STOPWORDS.has(only);
  }
  return run.some((t) => !STOPWORDS.has(t.toLowerCase()));
}

/**
 * Every way `q` could divide into a name and some title words, best-first.
 *
 * Empty for anything that cannot usefully split — a single token (which the existing name
 * and title tiers already answer whole), or a query past MAX_QUERY_TOKENS. An empty result
 * is the signal to leave the search exactly as it was, which is why the common cases cost
 * nothing: a one-word query never reaches the probe at all.
 *
 * Ordered longest-run-first, and trailing before leading at equal length. The order is a
 * tie-break of last resort rather than a prediction — the probe scores every candidate
 * against every book it matches and keeps the best per book, so a candidate's position here
 * does not decide the results. It only decides which candidates survive MAX_CANDIDATES.
 * Trailing leads because "title author" is the more common way a reader types both.
 */
export function splitCandidates(q: string): SplitCandidate[] {
  const tokens = tokenise(q);
  if (tokens.length < 2 || tokens.length > MAX_QUERY_TOKENS) return [];

  const candidates: SplitCandidate[] = [];
  const seen = new Set<string>();
  const maxRun = Math.min(MAX_NAME_TOKENS, tokens.length - 1);

  // Longest first: a longer run is a more specific claim about where the name is, and the
  // arm that matches it is the more selective one.
  for (let len = maxRun; len >= 1; len--) {
    const runs: { nameTokens: string[]; titleTokens: string[]; position: 'leading' | 'trailing' }[] = [
      {
        nameTokens: tokens.slice(tokens.length - len),
        titleTokens: tokens.slice(0, tokens.length - len),
        position: 'trailing',
      },
      {
        nameTokens: tokens.slice(0, len),
        titleTokens: tokens.slice(len),
        position: 'leading',
      },
    ];

    for (const run of runs) {
      if (!isPlausibleName(run.nameTokens)) continue;
      const name = run.nameTokens.join(' ');
      // A two-token query yields the same name run from both ends at length 1 only when
      // the tokens are equal; more usefully, longer runs from opposite ends can coincide
      // on short queries. Probing the same string twice buys nothing and costs two arms.
      const key = `${name.toLowerCase()}|${run.titleTokens.join(' ').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...run, name, titleMatchTokens: titleMatchTokensFor(run.titleTokens) });
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }

  return candidates;
}
