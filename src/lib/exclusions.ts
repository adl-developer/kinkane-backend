import { sql, eq, and, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { books, bookContributors, userBooks, userDislikedBooks } from '../db/schema';
import { redis } from './redis';
import { logger } from './logger';

/**
 * A book identified by the work it is, rather than by the catalogue row it
 * happens to be. `author` is null when the catalogue has no A01 contributor
 * for it, which downgrades the match to title-only.
 */
export interface ExcludedWork {
  title: string;
  author: string | null;
}

export interface UserExclusions {
  /** Exact catalogue rows to exclude — cheap, indexed. */
  bookIds: number[];
  /** Works to exclude regardless of which edition they show up as. */
  works: ExcludedWork[];
}

export const EMPTY_EXCLUSIONS: UserExclusions = { bookIds: [], works: [] };

/**
 * The normalization used on both sides of every author comparison, and the form
 * title/author snapshots are stored in. Must stay in lockstep with the SQL below
 * (`lower(btrim(...))`) — if these two ever disagree, exclusions silently stop
 * matching.
 */
export function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The title half of "is this the same work?": case, punctuation, "&" for "and",
 * and a leading or trailing article all fold away, so "Secret Lives of Baba
 * Segi's Wives", "The Secret Lives of Baba Segi's Wives" and "Secret Lives of
 * Baba Segi's Wives, The" are one title.
 *
 * {@link titleMatchSql} is its SQL twin and the two must agree character for
 * character — that is the whole contract. It is why this stops short of
 * lib/dedupe's normalizeWorkText, which also strips accents: the database has no
 * unaccent extension, so "Café" and "Cafe" stay apart here. Idempotent, and
 * accepts a stored normalizeForMatch snapshot as input, so snapshots written
 * before this existed match exactly as a fresh title would.
 */
export function normalizeTitleForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    // ICU's [[:alnum:]]: Alphabetic plus decimal digits — not \p{N}, which would
    // also keep superscripts and fractions that the SQL side turns into spaces.
    .replace(/[^\p{Alphabetic}\p{Nd}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .replace(/ (the|a|an)$/, '');
}

/**
 * {@link normalizeTitleForMatch} in SQL. The ICU collation is load-bearing: the
 * database runs ctype C, under which lower() and [[:alnum:]] only know ASCII, so
 * without it an accented title would fold differently here than in JS.
 */
export function titleMatchSql(title: SQL | PgColumn): SQL {
  return sql`regexp_replace(
    regexp_replace(
      btrim(regexp_replace(
        replace(lower(${title} COLLATE "und-x-icu"), '&', ' and '),
        '[^[:alnum:]]+', ' ', 'g'
      )),
      '^(the|a|an) ', ''
    ),
    ' (the|a|an)$', ''
  )`;
}

/**
 * The author half of "is this the same work?": the form both sides of every
 * author comparison are reduced to before they meet.
 *
 * The feeds spell one person several ways — about one A01 name in five carries
 * a doubled space ("Robert  Toft"), initials come with and without full stops
 * ("A. S. Byatt", "A S Byatt"), and some rows are surname-first ("Patchett,
 * Ann"). A plain lower/trim left those as different people, so the same book
 * could slip past an author-qualified exclusion. This folds full stops to
 * spaces, flips a single "Surname, First" (but not a "King, Jr." suffix) and
 * collapses whitespace. A name with more than one comma is left unflipped —
 * there is no telling which part is the surname.
 *
 * {@link authorMatchSql} is its SQL twin and the two must agree character for
 * character. Idempotent, and accepts a stored normalizeForMatch snapshot.
 */
export function normalizeAuthorForMatch(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/^([^,]+),(?!\s*(?:jr|sr|ii|iii|iv)\.?$)\s*([^,]+)$/, '$2 $1')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** {@link normalizeAuthorForMatch} in SQL — see titleMatchSql for why ICU. */
export function authorMatchSql(name: SQL | PgColumn): SQL {
  // Postgres treats parentheses inside a lookahead as non-capturing, so the
  // name halves are \1 and \2 here exactly as they are $1 and $2 in JS.
  return sql`btrim(regexp_replace(
    replace(
      regexp_replace(
        btrim(lower(${name} COLLATE "und-x-icu")),
        '^([^,]+),(?!\\s*(jr|sr|ii|iii|iv)\\.?$)\\s*([^,]+)$', '\\2 \\1'
      ),
      '.', ' '
    ),
    '\\s+', ' ', 'g'
  ))`;
}

// Bracketed text after the title proper — "(Harper Perennial Modern Classics)",
// "[Large Print]", "(light novel)" — is edition dressing, not part of the work's
// name. Either set off by a space, or glued to the end of the title
// ("Bel Canto(Large Print)"). A bracket that opens the title ("(Un)Natural") or
// sits glued inside it ("Friend(s) Forever") is part of the name.
const TITLE_BRACKETS =
  /\s+[([][^)\]]*[)\]]|(?<=[\p{Alphabetic}\p{Nd}])[([][^)\]]*[)\]](?=\s*$)/gu;
const TITLE_BRACKETS_SQL =
  '\\s+[\\(\\[][^\\)\\]]*[\\)\\]]|(?<=[[:alnum:]])[\\(\\[][^\\)\\]]*[\\)\\]](?=\\s*$)';

// A subtitle: everything after the first "Title: ", "Title - " or "Title—".
// The space after the colon is required, so "Re:ZERO" keeps its name; an
// unspaced hyphen ("Catch-22") or en dash ("1914–1918") is not a separator, an
// em dash is. One source string serves both twins — the syntax is common to JS
// (with the s flag) and Postgres AREs.
const TITLE_SUBTITLE_SOURCE = '(?::\\s| [-–]\\s|—).*$';
const TITLE_SUBTITLE = new RegExp(TITLE_SUBTITLE_SOURCE, 's');

// The words that mark a subtitle as edition dressing rather than part of the
// work's name: "Bel Canto: A Novel", "Wonder: Illustrated Edition", "Mad Honey:
// A GMA Book Club Pick", "A Game of Thrones: Book 1 of A Song of Ice and Fire".
// Only such a subtitle is cut for the core title. Cutting every subtitle hid
// sequels and companions that share a series name — "Hedgewitch: Stonewitch"
// once "Hedgewitch" was read — which is a different book, not another edition.
const EDITION_MARKERS = [
  'novel', 'novella', 'memoir', 'thriller', 'edition', 'illustrated', 'anniversary',
  'book club', 'adapted', 'deluxe', 'classics?', 'translation', 'translated',
  'tie-in', 'tie in', 'collector.?s', 'graphic', 'unabridged', 'abridged', 'annotated',
  'large print', 'paperback', 'hardback', 'hardcover', 'reissue', 'revised', 'expanded',
  'unexpurgated', 'young readers', 'movie', 'film', 'motion picture', 'winner', 'prize',
  'bestseller', 'facsimile', 'centenary', 'oprah', 'book (?:1|one) of',
].join('|');
const EDITION_SUBTITLE = new RegExp(
  `${TITLE_SUBTITLE_SOURCE.slice(0, -1)}(?<![\\p{Alphabetic}\\p{Nd}])(?:${EDITION_MARKERS})(?![\\p{Alphabetic}\\p{Nd}])`,
  'su',
);
const EDITION_SUBTITLE_SQL = `${TITLE_SUBTITLE_SOURCE.slice(0, -1)}(?<![[:alnum:]])(?:${EDITION_MARKERS})(?![[:alnum:]])`;

// Volume, level and part numbers, written as digits or Roman numerals: up to
// three digits (so a year on a calendar is not a volume) or a run of two or
// more of i/v/x. A lone "i" or "x" is too often a word ("The King and I").
// Matched as a whole word — the lookarounds use the same letter-or-digit class
// as normalizeTitleForMatch, so this finds exactly the words that fold would
// split out, without paying for the fold.
const VOLUME_WORD = /(?<![\p{Alphabetic}\p{Nd}])(\d{1,3}|[ivx]{2,})(?![\p{Alphabetic}\p{Nd}])/gu;
const VOLUME_WORD_SQL = '(?<![[:alnum:]])([0-9]{1,3}|[ivx]{2,})(?![[:alnum:]])';

// Inside an edition note only a number that follows a volume word counts:
// "(Vol. 3)" and "(Book II)" are volumes, the "100" in "(Penguin Classics 100)"
// is not. Any Roman numeral is allowed here, since "Book I" is unambiguous.
const BRACKET_VOLUME =
  /(?<![\p{Alphabetic}\p{Nd}])(?:vol|volume|book|part|no|tome|level)\.?\s*(\d{1,3}|[ivx]+)(?![\p{Alphabetic}\p{Nd}])/gu;
const BRACKET_VOLUME_SQL =
  '(?<![[:alnum:]])(?:vol|volume|book|part|no|tome|level)\\.?\\s*([0-9]{1,3}|[ivx]+)(?![[:alnum:]])';

const stripLeadingZeros = (word: string) => (/^\d+$/.test(word) ? word.replace(/^0+(?=\d)/, '') : word);

/**
 * The volume numbers in a title, sorted, as one string. Two titles can only be
 * the same work when these agree — that is what keeps "Tokyo Ghoul (Vol. 3)"
 * and "Tokyo Ghoul (Vol. 9)" apart once the brackets are ignored. Every number
 * outside the brackets counts, subtitle included; inside them, only one that
 * follows a volume word, so a series number in an edition note does not stop
 * two editions matching. Two titles that fold identically always agree here.
 *
 * `forCore` is the set for the core key, which only exists when an edition
 * subtitle is cut: there a "1" in the subtitle is dropped, because "Book 1 of
 * A Song of Ice and Fire" describes the same book as the plain "A Game of
 * Thrones" rather than a different volume.
 */
function titleVolumes(value: string, forCore = false): string {
  const lowered = value.toLowerCase();
  const unbracketed = lowered.replace(TITLE_BRACKETS, '');
  const words = (text: string) => [...text.matchAll(VOLUME_WORD)].map(([, w]) => stripLeadingZeros(w));
  const inBrackets = (lowered.match(TITLE_BRACKETS) ?? []).flatMap((segment) =>
    [...segment.matchAll(BRACKET_VOLUME)].map(([, w]) => stripLeadingZeros(w)),
  );
  // The title and subtitle split only matters for the core set; the full set
  // reads the unbracketed title in one pass, which gives the same words.
  const outside = forCore
    ? [
        ...words(unbracketed.replace(TITLE_SUBTITLE, '')),
        ...words(unbracketed.match(TITLE_SUBTITLE)?.[0] ?? '').filter((w) => w !== '1'),
      ]
    : words(unbracketed);
  return [...outside, ...inBrackets].sort().join(' ');
}

function titleVolumesSql(lowered: SQL, unbracketed: SQL, forCore: boolean): SQL {
  // Most titles have no volume number. A plain regex test lets them skip the
  // set-returning subquery below, which is most of what this costs. Both
  // patterns are in the test because a bracketed "Book I" matches only the
  // second; one alternation is one scan of the title rather than two.
  const outside = forCore
    ? sql`SELECT 'main' AS part, m[1] AS word
        FROM regexp_matches(regexp_replace(${unbracketed}, ${TITLE_SUBTITLE_SOURCE}, ''), ${VOLUME_WORD_SQL}, 'g') AS m
        UNION ALL
        SELECT 'sub', m[1]
        FROM regexp_matches((regexp_match(${unbracketed}, ${`(${TITLE_SUBTITLE_SOURCE})`}))[1], ${VOLUME_WORD_SQL}, 'g') AS m`
    : sql`SELECT 'main' AS part, m[1] AS word
        FROM regexp_matches(${unbracketed}, ${VOLUME_WORD_SQL}, 'g') AS m`;
  const dropSubtitleOne = forCore ? sql`WHERE NOT (part = 'sub' AND volume = '1')` : sql``;
  return sql`CASE WHEN ${lowered} !~ ${`${VOLUME_WORD_SQL}|${BRACKET_VOLUME_SQL}`}
    THEN '' ELSE coalesce((
    SELECT string_agg(volume, ' ' ORDER BY volume COLLATE "C")
    FROM (
      SELECT part,
             CASE WHEN word ~ '^[0-9]+$'
                  THEN regexp_replace(word, '^0+(?=[0-9])', '')
                  ELSE word END AS volume
      FROM (
        ${outside}
        UNION ALL
        SELECT 'bracket', v[1]
        FROM regexp_matches(${lowered}, ${TITLE_BRACKETS_SQL}, 'g') AS seg,
             regexp_matches(seg[1], ${BRACKET_VOLUME_SQL}, 'g') AS v
      ) AS words
    ) AS volumes
    ${dropSubtitleOne}
  ), '') END`;
}

/**
 * The two keys a title is matched on — "is this the same work?" for titles.
 *
 *  - `full`: the title with trailing brackets dropped, then folded.
 *  - `core`: the same with an edition subtitle ("…: A Novel", "…: Illustrated
 *    Edition") cut off too. Equal to `full` when there is no such subtitle, or
 *    when cutting would leave nothing.
 *
 * Both are prefixed with {@link titleVolumes}. Two titles match when one's
 * `full` equals the other's `full` or `core` — never `core` against `core`.
 * That one-sidedness is the point: "Bel Canto: A Novel" matches "Bel Canto",
 * but "Bel Canto: A Novel" and "Bel Canto: Illustrated Edition" only match
 * through the plain title, never through each other's leftovers. Measured on
 * the catalogue, a core-to-core match over every subtitle merged 15,609
 * same-author pairs that were nearly all different books in one series.
 *
 * A fuzzy similarity score was tried and rejected: among books by one author,
 * every pg_trgm cutoff from 0.6 to 0.95 matched mostly different books
 * ("Theory A" / "Theory B", "Workbook with Key" / "without Key").
 *
 * {@link titleKeysSql} is the SQL twin. Every title that matched under the
 * plain {@link normalizeTitleForMatch} fold still matches here.
 */
export function titleKeysForMatch(value: string): { full: string; core: string } {
  const unbracketed = value.toLowerCase().replace(TITLE_BRACKETS, '');
  const fullTitle = normalizeTitleForMatch(unbracketed) || normalizeTitleForMatch(value);
  const full = `${titleVolumes(value)}#${fullTitle}`;
  if (!EDITION_SUBTITLE.test(unbracketed)) return { full, core: full };
  const coreTitle = normalizeTitleForMatch(unbracketed.replace(TITLE_SUBTITLE, ''));
  return { full, core: coreTitle ? `${titleVolumes(value, true)}#${coreTitle}` : full };
}

/** {@link titleKeysForMatch} in SQL. */
export function titleKeysSql(title: SQL | PgColumn): { full: SQL; core: SQL } {
  const lowered = sql`lower(${title} COLLATE "und-x-icu")`;
  const unbracketed = sql`regexp_replace(${lowered}, ${TITLE_BRACKETS_SQL}, '', 'g')`;
  const full = sql`(${titleVolumesSql(lowered, unbracketed, false)} || '#' ||
    coalesce(nullif(${titleMatchSql(unbracketed)}, ''), ${titleMatchSql(title)}))`;
  // NULL anywhere in the CASE branch (no edition subtitle, or nothing left
  // after the cut) falls through to the full key, as in the JS twin.
  const core = sql`coalesce(
    CASE WHEN ${unbracketed} ~ ${EDITION_SUBTITLE_SQL}
      THEN ${titleVolumesSql(lowered, unbracketed, true)} || '#' ||
           nullif(${titleMatchSql(sql`regexp_replace(${unbracketed}, ${TITLE_SUBTITLE_SOURCE}, '')`)}, '')
    END,
    ${full}
  )`;
  return { full, core };
}

/**
 * The excluded works as the two lists the match runs on: the keys a
 * candidate's `full` is checked against (the work's `full` and `core`), and
 * the keys its `core` is checked against (the work's `full` only). One row per
 * key and author, so a book with two authors is anchored by either.
 */
function workMatchRows(works: ExcludedWork[]) {
  const againstFull = new Map<string, { key: string; author: string | null }>();
  const againstCore = new Map<string, { key: string; author: string | null }>();
  for (const work of works) {
    const { full, core } = titleKeysForMatch(work.title);
    // Not `|| null`: a name that folds to nothing ("." in the feed) is still a
    // recorded author, so it must not widen into a title-only exclusion.
    const author = work.author === null ? null : normalizeAuthorForMatch(work.author);
    for (const key of [full, core]) againstFull.set(`${key}\u0000${author}`, { key, author });
    againstCore.set(`${full}\u0000${author}`, { key: full, author });
  }
  return { againstFull: [...againstFull.values()], againstCore: [...againstCore.values()] };
}

/**
 * Bumped whenever the rule for "same work" changes, so caches holding lists
 * filtered by an older rule (quiz results, keyed through hashInput) are
 * retired rather than served until they expire.
 */
export const WORK_MATCH_VERSION = 2;

/**
 * Builds the "none of these works" predicate.
 *
 * Written as a single NOT EXISTS over a VALUES list rather than one AND'd
 * condition per work, so the query plan doesn't degrade as a user's dislike
 * list grows — a reader who has rejected 200 books gets the same shape of
 * query as one who has rejected 3.
 *
 * The match is by title — "the same title" as {@link titleKeysForMatch}
 * defines it, so a leading "The", a subtitle or an edition note in brackets
 * does not make a second work — with the author acting as a tie-breaker that
 * only gets to *rescue* a same-titled book, never to let one through on a
 * technicality. So a candidate is excluded when its title matches and any of:
 *
 *  - the rejection has no author recorded (we don't know who wrote the book
 *    the user rejected), or
 *  - the candidate has no A01 author recorded (an untagged catalogue row), or
 *  - the two authors match, as {@link normalizeAuthorForMatch} folds them.
 *
 * Only a same-titled book by a *known, different* author survives, and other
 * books by the same author are untouched unless their title matches. Both
 * unknown-author branches deliberately err towards over-excluding: one missing
 * book in a list of a hundred costs nothing, while re-recommending the book
 * someone just told us they'd read reads as the quiz not listening.
 *
 * Returns undefined for an empty list so callers can spread it into an
 * `and(...)` without a special case.
 */
export function buildWorkExclusionCondition(works: ExcludedWork[]): SQL | undefined {
  if (works.length === 0) return undefined;

  const { againstFull, againstCore } = workMatchRows(works);
  const candidate = titleKeysSql(books.title);

  // Two lists rather than one OR'd condition, because each stays a plain
  // equality Postgres can hash: a candidate's full title against the works'
  // full and core titles, then its core title against the works' full titles.
  // A candidate with no edition subtitle has core = full, which the first list already
  // covers, so its core key is left NULL (never equal to anything) rather than
  // folded again. Done inside the key, not as an OR around the clause: an OR
  // stops Postgres turning NOT EXISTS into a hashed anti-join, and the query
  // then folds the title once per excluded work — minutes, not milliseconds.
  // Under the ICU collation like every other regex here: in ctype C, \s misses
  // a non-breaking space after the colon, which the JS twin's \s matches.
  // Nested so the cheap separator test runs first and the edition-word regex
  // (with its backtracking) only on the minority of titles that have one —
  // that ordering halves the cost of this clause.
  const coreKey = sql`CASE WHEN ${books.title} COLLATE "und-x-icu" ~ ${TITLE_SUBTITLE_SOURCE}
    THEN CASE WHEN lower(${books.title} COLLATE "und-x-icu") ~ ${EDITION_SUBTITLE_SQL} THEN ${candidate.core} END
  END`;
  return sql`(${workMatchClause(againstFull, candidate.full)}
    AND ${workMatchClause(againstCore, coreKey)})`;
}

function workMatchClause(
  rows: { key: string; author: string | null }[],
  candidateKey: SQL,
): SQL {
  // The ::text casts are load-bearing, not decoration: these are bind
  // parameters inside a VALUES list, and Postgres cannot always infer a type
  // for an untyped parameter there — it fails the whole query with "could not
  // determine data type of parameter". Naming the type sidesteps the inference
  // entirely, and matters most in the all-null-author case where there is no
  // sibling row to infer from.
  const values = rows.map((r) => sql`(${r.key}::text, ${r.author}::text)`);

  // Folding the candidate's title costs a few µs a row. Postgres hashes the
  // VALUES list and folds each candidate once per probe, so this stays one fold
  // per row however long the list is. Hoisting the fold into its own OFFSET 0
  // subquery looks cheaper and measured ten times slower, since it defeats the
  // hashing.
  return sql`NOT EXISTS (
    SELECT 1
    FROM (VALUES ${sql.join(values, sql`, `)}) AS excluded_work(title, author)
    WHERE excluded_work.title = ${candidateKey}
      AND (
        excluded_work.author IS NULL
        OR NOT EXISTS (${namedAuthorSubquery()})
        OR EXISTS (
          SELECT 1
          FROM book_contributors bc
          WHERE bc.book_id = ${books.id}
            AND bc.role = 'A01'
            AND ${authorMatchSql(sql`bc.person_name`)} = excluded_work.author
        )
      )
  )`;
}

/**
 * The single definition of "this catalogue row has a real, named author",
 * used by every site that has to make that call. It exists because the answer
 * was previously spelled out three times with two different meanings: a
 * contributor row carrying an empty name counted as an author in one place and
 * not in another, so the same book could be filtered from one surface and
 * shown on the next. `hasNamedAuthor` below is the in-memory twin of exactly
 * this rule.
 *
 * Emitted as a subquery body so callers can wrap it in EXISTS or NOT EXISTS
 * without restating the conditions.
 */
function namedAuthorSubquery(): SQL {
  return sql`SELECT 1
      FROM book_contributors bc
      WHERE bc.book_id = ${books.id}
        AND bc.role = 'A01'
        AND bc.person_name IS NOT NULL
        AND btrim(bc.person_name) <> ''`;
}

/**
 * "This book has a named author."
 *
 * A catalogue row with no A01 contributor — or one whose contributor row
 * exists but carries no name — is not a recommendable book: the reader sees a
 * cover, a title, and a blank where the author should be, which reads as a
 * broken record rather than a suggestion. The ONIX feeds have real gaps here,
 * so this is a live condition rather than a theoretical one.
 *
 * Applied as a WHERE predicate rather than a post-filter for the same reason
 * the work exclusion is: dropping rows afterwards silently shortens the list,
 * while a predicate lets the search top itself back up.
 */
export function buildHasAuthorCondition(): SQL {
  return sql`EXISTS (${namedAuthorSubquery()})`;
}

/**
 * True when at least one A01 contributor carries a usable name. The in-memory
 * twin of `namedAuthorSubquery` — a contributor whose name is blank or only
 * whitespace is not an author, matching `btrim(person_name) <> ''` in SQL.
 */
export function hasNamedAuthor(
  contributors: { role: string | null; personName: string | null }[],
): boolean {
  return contributors.some((c) => c.role === 'A01' && !!c.personName?.trim());
}

/**
 * The in-memory twin of `buildWorkExclusionCondition`, for lists that have
 * already been built and can't be re-queried — specifically the per-book
 * "you may also like" cache, which is shared across users and so can only be
 * filtered after it's read.
 *
 * Applies the identical rule: excluded by ID, or the title matches and the
 * author does not actively contradict it — see buildWorkExclusionCondition for
 * the three branches. Any divergence between this and the SQL version is a bug
 * in whichever one is wrong.
 */
export function filterExcludedWorks<
  T extends {
    id: number;
    title: string;
    // Both nullable in the catalogue — a contributor row can exist with no
    // role or no name.
    contributors: { role: string | null; personName: string | null }[];
  },
>(items: T[], exclusions: UserExclusions): T[] {
  if (exclusions.bookIds.length === 0 && exclusions.works.length === 0) return items;

  const excludedIds = new Set(exclusions.bookIds);

  // Keyed by title so each item is two map lookups rather than a scan of the
  // whole rejection list — the same two lists, matched the same way, as the
  // SQL twin.
  const { againstFull, againstCore } = workMatchRows(exclusions.works);
  const group = (rows: { key: string; author: string | null }[]) => {
    const authorsByKey = new Map<string, (string | null)[]>();
    for (const { key, author } of rows) {
      const authors = authorsByKey.get(key);
      if (authors) authors.push(author);
      else authorsByKey.set(key, [author]);
    }
    return authorsByKey;
  };
  const authorsByFull = group(againstFull);
  const authorsByCore = group(againstCore);

  return items.filter((item) => {
    if (excludedIds.has(item.id)) return false;

    const keys = titleKeysForMatch(item.title);
    const excludedAuthors = [
      ...(authorsByFull.get(keys.full) ?? []),
      ...(authorsByCore.get(keys.core) ?? []),
    ];
    if (excludedAuthors.length === 0) return true;

    // An untagged catalogue row has nothing to disprove the title match with,
    // so the title alone decides — mirrors the NOT EXISTS branch in the SQL.
    // Blank and whitespace-only names count as untagged here exactly as they
    // do there; that agreement is the point of sharing hasNamedAuthor.
    if (!hasNamedAuthor(item.contributors)) return false;

    const itemAuthors = item.contributors
      .filter((c) => c.role === 'A01' && !!c.personName?.trim())
      .map((c) => normalizeAuthorForMatch(c.personName as string));

    return !excludedAuthors.some(
      (author) => author === null || itemAuthors.includes(author),
    );
  });
}

/**
 * Every book a user should never be recommended, in the shape the exclusion
 * predicate wants. Two sources, deliberately merged into one set:
 *
 *  - books they rejected (user_disliked_books)
 *  - books already on their shelf (user_books), whatever the source or reading
 *    status — a book they own, are reading, or have finished is not a
 *    recommendation, and re-surfacing it in a quiz reads as the quiz not
 *    knowing them
 *
 * Both are matched at work level, so a paperback on the shelf also suppresses
 * the hardback and the ebook.
 *
 * Dislikes carry their own normalized title/author snapshot, frozen at the
 * moment of rejection. Shelf books have no such snapshot, so their titles are
 * resolved live — meaning a shelf exclusion follows catalogue corrections while
 * a dislike keeps the form the user actually rejected.
 *
 * Redis-cached because this is read on every personalized feed request while
 * the underlying set only changes when the user swipes a book away or edits
 * their shelf — both of which bust it (see `bustUserExclusions`).
 *
 * Never throws: a Redis or Postgres hiccup here degrades to "no exclusions"
 * rather than failing the feed. The cost of that degradation is one unwanted
 * book in a list; the cost of throwing is an empty screen.
 */
export async function getUserExclusions(userId: number): Promise<UserExclusions> {
  const cacheKey = exclusionsCacheKey(userId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as UserExclusions;
  } catch (err) {
    logger.error('Failed to read exclusions cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const [dislikedRows, shelfRows] = await Promise.all([
      db
        .select({
          bookId: userDislikedBooks.bookId,
          title: userDislikedBooks.titleNormalized,
          author: userDislikedBooks.authorNormalized,
        })
        .from(userDislikedBooks)
        .where(eq(userDislikedBooks.userId, userId)),

      db
        .select({ bookId: userBooks.bookId })
        .from(userBooks)
        .where(eq(userBooks.userId, userId)),
    ]);

    // Shelf books need the same normalized title/author shape a dislike stores.
    // Resolved live with every named author, not just the first, so an edition
    // credited only to a co-author still matches. Disliked books get the same
    // treatment on top of their frozen first-author snapshot, which on its own
    // would miss that edition too.
    const liveWorks = await resolveAllAuthorWorks([
      ...new Set([...shelfRows.map((r) => r.bookId), ...dislikedRows.map((r) => r.bookId)]),
    ]);

    // A book can be on the shelf and disliked at once (added, then rejected in
    // a later quiz), and two shelf editions of one work collapse to the same
    // title/author pair. Dedup both lists so neither the ID filter nor the
    // VALUES clause in buildWorkExclusionCondition carries redundant rows.
    const exclusions: UserExclusions = {
      bookIds: [
        ...new Set([...dislikedRows.map((r) => r.bookId), ...shelfRows.map((r) => r.bookId)]),
      ],
      works: dedupeWorks([
        ...dislikedRows.map((r) => ({ title: r.title, author: r.author })),
        ...liveWorks,
      ]),
    };

    await redis
      .set(cacheKey, JSON.stringify(exclusions), 'EX', EXCLUSIONS_TTL_SECONDS)
      .catch(() => undefined);

    return exclusions;
  } catch (err) {
    logger.error('Failed to load user exclusions', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_EXCLUSIONS;
  }
}

/**
 * Drops the cached exclusion set — call after any write to
 * user_disliked_books or user_books. Also clears the user's personalized feed,
 * which is built from these exclusions: without that, a book the user just
 * swiped away (or just added to their shelf) keeps showing up on the home feed
 * until the feed's own TTL expires.
 */
export async function bustUserExclusions(userId: number): Promise<void> {
  try {
    await Promise.all([
      redis.del(exclusionsCacheKey(userId)),
      bustPersonalizedFeedCache(userId),
    ]);
  } catch (err) {
    logger.error('Failed to bust exclusions cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The version prefix booksService.personalized writes under. It lives here as a
 * named constant because this file has to delete exactly what that file wrote,
 * and the two drifted once already: this deleted `personalized:v1:` for the
 * whole life of the v2 key, so it matched nothing and a user's rejected books
 * stayed in their feed for the full hour. Bump both together.
 */
const PERSONALIZED_CACHE_PREFIX = 'personalized:v6:';

/**
 * Busts the personalized feed cache for all limit variants. `limit` is bounded
 * to 1-20 by explore.controller's limitSchema, so we delete the exact bounded
 * key set directly rather than scanning the keyspace with KEYS — KEYS is an
 * O(N) blocking operation over the *entire* Redis instance and must never run
 * on a per-user write path.
 */
export async function bustPersonalizedFeedCache(userId: number): Promise<void> {
  const keys = Array.from(
    { length: PERSONALIZED_CACHE_MAX_LIMIT },
    (_, i) => `${PERSONALIZED_CACHE_PREFIX}${userId}:${i + 1}`,
  );
  await redis.del(...keys);
}

/**
 * Resolves book IDs to the normalized title/author snapshot stored alongside a
 * dislike. Shared by the guest-migration and logged-in write paths so both
 * store snapshots in exactly the same form.
 */
export async function resolveWorkSnapshots(
  bookIds: number[],
): Promise<Map<number, ExcludedWork>> {
  const snapshots = new Map<number, ExcludedWork>();
  if (bookIds.length === 0) return snapshots;

  const { bookRows, contributors } = await loadTitlesAndAuthors(bookIds);

  // First *named* A01 contributor wins — sequence-ordered above, and the
  // exclusion only needs one author to anchor the match. A blank name is
  // skipped rather than recorded, so a snapshot's author is either a real name
  // or null; anything else would make an exclusion look author-qualified while
  // matching nothing.
  const primaryAuthor = new Map<number, string>();
  for (const c of contributors) {
    if (c.personName?.trim() && !primaryAuthor.has(c.bookId)) {
      primaryAuthor.set(c.bookId, c.personName);
    }
  }

  for (const row of bookRows) {
    const author = primaryAuthor.get(row.id);
    snapshots.set(row.id, {
      title: normalizeForMatch(row.title),
      author: author ? normalizeForMatch(author) : null,
    });
  }

  return snapshots;
}

/**
 * Resolves book IDs to one excluded work per named A01 author — the live form
 * used for books that are excluded but have no single stored author (shelf
 * books, a basket), and to widen a dislike's frozen first-author snapshot. A
 * book with no named author becomes one title-only work.
 */
export async function resolveAllAuthorWorks(bookIds: number[]): Promise<ExcludedWork[]> {
  if (bookIds.length === 0) return [];

  const { bookRows, contributors } = await loadTitlesAndAuthors(bookIds);
  const authorsByBook = new Map<number, string[]>();
  for (const c of contributors) {
    if (!c.personName?.trim()) continue;
    const authors = authorsByBook.get(c.bookId);
    if (authors) authors.push(c.personName);
    else authorsByBook.set(c.bookId, [c.personName]);
  }

  return bookRows.flatMap((row): ExcludedWork[] => {
    const title = normalizeForMatch(row.title);
    const authors = authorsByBook.get(row.id) ?? [];
    return authors.length > 0
      ? authors.map((author) => ({ title, author: normalizeForMatch(author) }))
      : [{ title, author: null }];
  });
}

async function loadTitlesAndAuthors(bookIds: number[]) {
  const [bookRows, contributors] = await Promise.all([
    db.select({ id: books.id, title: books.title }).from(books).where(inArray(books.id, bookIds)),
    db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(and(inArray(bookContributors.bookId, bookIds), eq(bookContributors.role, 'A01')))
      .orderBy(bookContributors.sequenceNumber),
  ]);
  return { bookRows, contributors };
}

/** Collapses works to one entry per set of match keys and folded author. */
function dedupeWorks(works: ExcludedWork[]): ExcludedWork[] {
  const byKey = new Map<string, ExcludedWork>();
  for (const work of works) {
    // Explicit NUL separator so a title/author pair can't collide with a
    // differently-split pair whose title happens to contain the separator.
    // Keyed on what the match actually compares — the title keys and the
    // folded author — so two works that look alike under the plain fold but
    // match different editions ("X (Vol. 2)" and "X Vol 2") both survive.
    const { full, core } = titleKeysForMatch(work.title);
    const author = work.author === null ? '\u0001' : normalizeAuthorForMatch(work.author);
    byKey.set(`${full}\u0000${core}\u0000${author}`, work);
  }
  return [...byKey.values()];
}

const EXCLUSIONS_TTL_SECONDS = 60 * 60; // 1 hour — writes bust it explicitly

const PERSONALIZED_CACHE_MAX_LIMIT = 20;

// v2 — shelf books joined the set. The bump retires v1 entries, which held
// dislikes only and would otherwise keep serving shelf books for up to an hour
// after deploy.
// v3 — every named author of a shelf or disliked book, not just the first.
function exclusionsCacheKey(userId: number): string {
  return `exclusions:v3:${userId}`;
}
