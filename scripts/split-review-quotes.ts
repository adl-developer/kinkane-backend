/**
 * Splits each supplier's review blob into one row per review, with the
 * review's text and its source in separate columns.
 *
 *   npx tsx scripts/split-review-quotes.ts [comparison-folder]
 *
 * Neither supplier's API gives us separate reviews: each sends one HTML field
 * per book with every quote run together and the source written into the
 * text. This reverses that, per supplier, using the layouts actually seen in
 * the data (2026-09-26):
 *
 *   BDS      quote<br /><i>Source</i><br /><br />next quote...
 *            quote --<b>Source, date</b>
 *   Nielsen  quote * Source *<br />next quote * Source *
 *            <p>quote</p><p>more of it</p><p><em>Source</em></p>
 *            'quote' - Source
 *
 * It is a heuristic over free text, not a parser of structured data, so every
 * row says *how* its source was found (`source_found_by`), and anything it
 * could not attribute is kept with an empty source rather than guessed.
 *
 * Reads the comparison folder written by nielsen-bds-comparison.ts, plus the
 * raw Nielsen text cached beside it (nielsen-raw-reviews.json) and the raw BDS
 * text from the database. Writes book-reviews-separated.csv to the same folder.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { redis } from '../src/lib/redis';

const dir = process.argv[2] ?? join(__dirname, '../probe-output/comparison-2026-09-25');

// ── Text clean-up ───────────────────────────────────────────────────────────

/** Windows-1252 characters that arrive as numeric entities in the 128–159 range. */
const CP1252: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹',
  140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™',
  154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è', euml: 'ë', uuml: 'ü',
  ouml: 'ö', auml: 'ä', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç', pound: '£',
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => CP1252[Number(n)] ?? String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** Readable text: tags gone, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "The Voice - The Voice" → "The Voice". BDS often repeat the outlet name. */
function cleanSource(s: string): string {
  const t = text(s).replace(/^[-–—*\s]+|[-–—*\s]+$/g, '').trim();
  const doubled = t.match(/^(.+?)\s+-\s+\1$/i);
  return doubled ? doubled[1] : t;
}

const STARTS_WITH_QUOTE = /^[\s.]*["“‘'«]/;

export interface Review {
  text: string;
  source: string;
  foundBy: string;
}

// ── Splitting ───────────────────────────────────────────────────────────────
//
// One splitter for both suppliers. They were expected to differ, but BDS
// often pass the publisher's text through untouched, so the same paragraph
// layouts turn up in both. Each chunk is tried against every known layout.

/** A short paragraph that names a source rather than quoting anyone. */
function isAttributionParagraph(html: string): boolean {
  const t = text(html);
  if (!t || t.length > 160) return false;
  if (STARTS_WITH_QUOTE.test(t)) return false;
  // Wholly italic, a leading dash, or "Name, Affiliation" — all seen live.
  // The last allows full stops, because initials have them ("Dabney A.
  // Bankert, Professor Emerita..."), but not a sentence-final one, which is
  // what separates a name from a short review sentence.
  return (
    /^\s*<(em|i)>[\s\S]*<\/\1>\s*$/i.test(html.trim()) ||
    /^[-–—]/.test(t) ||
    (/^[A-Z][^!?]{1,80}?[,;]/.test(t) && !/[.!?]$/.test(t))
  );
}

/** A heading such as "Praise for the second edition" — not a review. */
function isHeading(html: string): boolean {
  const t = text(html);
  return t.length > 0 && t.length <= 80 && !STARTS_WITH_QUOTE.test(t) &&
    (/^\s*<(strong|b)>[\s\S]*<\/\1>\s*$/i.test(html.trim()) || /:$/.test(t)) && !/[,;]/.test(t.slice(0, -1));
}

/** A chunk that carries its own source: returns the review, or null. */
function selfAttributed(chunk: string): Review | null {
  // quote<br /><i>Source</i> — the usual BDS layout
  let m = chunk.match(/^([\s\S]*?)<br\s*\/?>\s*<(i|em)>([\s\S]+?)<\/\2>\s*$/i);
  if (m && text(m[1])) return { text: text(m[1]), source: cleanSource(m[3]), foundBy: 'italic line after the quote' };

  // quote --<b>Source</b>, or quote -- Source
  m = chunk.match(/^([\s\S]*?\S)\s*--\s*(<(b|strong)>[\s\S]+?<\/\3>|[^<]{2,120})\s*$/i);
  if (m && text(m[1])) return { text: text(m[1]), source: cleanSource(m[2]), foundBy: '"--" before the source' };

  // 'quote' - Source
  m = chunk.match(/^([\s\S]*?["”’'])\s+-\s+([^"“”’<]{2,120})$/);
  if (m && text(m[1])) return { text: text(m[1]), source: cleanSource(m[2]), foundBy: '"-" before the source' };

  // 'quote' <strong><em>Source</em></strong> — the ONIX-style layout
  m = chunk.match(/^([\s\S]*?["”’'][\s\S]*?)\s*<(strong|b)>\s*(?:<(em|i)>)?([^<]{2,150})(?:<\/\3>)?\s*<\/\2>\s*$/i);
  if (m && text(m[1])) return { text: text(m[1]), source: cleanSource(m[4]), foundBy: 'bold name after the quote' };

  // "quote" -Name, "quote"<b>-Name</b>, 'quote'   Name, Affiliation — a short
  // tail after the closing quotation mark. Covers the variants that differ
  // only in dashes, spacing and tags.
  const tail = sourceAfterClosingQuote(chunk);
  if (tail) return tail;

  return null;
}

/**
 * Splits "quote" from what follows its closing quotation mark, when what
 * follows is short enough to be a name. Only applies when the chunk opens
 * with a quotation mark — otherwise a stray apostrophe could split ordinary
 * prose. The closing mark is the last quote character *not followed by a
 * letter*, which skips apostrophes inside words (D'Aronco, Children's).
 */
function sourceAfterClosingQuote(chunk: string): Review | null {
  const t = text(chunk).replace(/^[★☆\s]+/, '');
  if (!STARTS_WITH_QUOTE.test(t)) return null;

  let close = -1;
  for (let i = t.length - 1; i > 0; i--) {
    if (/["”’']/.test(t[i]) && !/[\p{L}]/u.test(t[i + 1] ?? '')) {
      close = i;
      break;
    }
  }
  if (close < 1) return null;

  const rest = t.slice(close + 1).trim();
  const source = rest.replace(/^[-–—]+\s*/, '').trim();
  if (source.length < 2 || source.length > 200) return null;
  // A name, not more prose: begins with a capital (or follows a dash), and has
  // no full sentence inside it.
  const dashed = /^[-–—]/.test(rest);
  if (!dashed && !/^[\p{Lu}]/u.test(source)) return null;
  if (/[.!?]\s+[\p{Lu}]/u.test(source) && !dashed) return null;

  return {
    text: t.slice(0, close + 1).trim(),
    source: cleanSource(source),
    foundBy: dashed ? '"-" before the source' : 'name after the closing quote',
  };
}

function splitReviews(html: string): Review[] {
  // Layout: quote * Source *, several per field, often joined by single <br />.
  if (/\*\s*[^*<>]{2,200}?\s*\*/.test(html)) {
    const reviews: Review[] = [];
    const re = /([\s\S]*?)\*\s*([^*<>]{2,200}?)\s*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const quote = text(m[1].replace(/^\s*(<br\s*\/?>|<\/?p[^>]*>)+/i, ''));
      if (quote) reviews.push({ text: quote, source: cleanSource(m[2]), foundBy: '"* Source *" after the quote' });
      last = re.lastIndex;
    }
    const rest = text(html.slice(last));
    if (rest) reviews.push({ text: rest, source: '', foundBy: 'no source in the text' });
    return reviews;
  }

  // Everything else: chunks separated by paragraphs or blank lines.
  const chunks = html
    .split(/<\/p>\s*<p[^>]*>|(?:<br\s*\/?>\s*){2,}/i)
    .map((c) => c.replace(/^\s*<p[^>]*>|<\/p>\s*$/gi, '').trim())
    // A chunk holding several "'quote' -- Name" reviews joined by single line
    // breaks is split on those breaks, or the first source would swallow every
    // review after it (seen live: four reviews, one "source").
    .flatMap((c) => ((c.match(/--\s*\S/g) ?? []).length >= 2 ? c.split(/<br\s*\/?>/i) : [c]))
    .map((c) => c.trim())
    .filter((c) => text(c));

  const reviews: Review[] = [];
  // Paragraphs of one review waiting for the paragraph that names its source.
  let pending: string[] = [];
  const flush = (source: string, foundBy: string) => {
    if (pending.length) reviews.push({ text: pending.map(text).join(' '), source, foundBy });
    pending = [];
  };

  for (const chunk of chunks) {
    if (isHeading(chunk)) {
      flush('', 'no source in the text');
      continue;
    }
    if (pending.length && isAttributionParagraph(chunk)) {
      flush(cleanSource(chunk), 'source in its own paragraph');
      continue;
    }
    const own = selfAttributed(chunk);
    if (own) {
      flush('', 'no source in the text');
      reviews.push(own);
      continue;
    }
    pending.push(chunk);
  }
  flush('', 'no source in the text');
  return reviews;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const books = parseCsv(readFileSync(join(dir, 'book-reviews-nielsen-vs-bds.csv'), 'utf8'))
    // Only books Nielsen actually answered for — the rest ran into its daily limit.
    .filter((b) => b.nielsen_has_record === 'yes' || b.nielsen_has_record === 'no')
    // Only books where at least one supplier has a review.
    .filter((b) => b.nielsen_has_review === 'yes' || b.bds_has_review === 'yes');

  const nielsenRaw = JSON.parse(readFileSync(join(dir, 'nielsen-raw-reviews.json'), 'utf8')) as Record<string, string>;
  const bdsRows = (await db.execute(sql`
    SELECT isbn13, review_html FROM book_reviews
    WHERE source = 'bds' AND review_html IS NOT NULL
      AND isbn13 IN (${sql.join(books.map((b) => sql`${b.isbn13}`), sql`, `)})
  `)) as unknown as { isbn13: string; review_html: string }[];
  const bdsRaw = new Map(bdsRows.map((r) => [r.isbn13, r.review_html]));

  const out: unknown[][] = [];
  const tally = { Nielsen: { reviews: 0, sourced: 0 }, BDS: { reviews: 0, sourced: 0 } };

  for (const book of books) {
    for (const [supplier, raw, split] of [
      ['Nielsen', nielsenRaw[book.isbn13], splitReviews],
      ['BDS', bdsRaw.get(book.isbn13), splitReviews],
    ] as const) {
      if (!raw) {
        out.push([book.isbn13, book.title, supplier, '', '(no reviews from this supplier)', '', '']);
        continue;
      }
      const reviews = split(raw);
      reviews.forEach((r, i) => {
        out.push([book.isbn13, book.title, supplier, i + 1, r.text, r.source, r.foundBy]);
        tally[supplier].reviews++;
        if (r.source) tally[supplier].sourced++;
      });
    }
  }

  const header = ['isbn13', 'title', 'supplier', 'review_no', 'review', 'source', 'source_found_by'];
  const path = join(dir, 'book-reviews-separated.csv');
  writeFileSync(path, [header.join(','), ...out.map((r) => r.map(csvCell).join(','))].join('\n'));

  console.log(`${books.length} books with a review from at least one supplier`);
  for (const [s, t] of Object.entries(tally)) {
    console.log(`  ${s.padEnd(8)} ${t.reviews} reviews, ${t.sourced} with a source (${t.reviews ? Math.round((100 * t.sourced) / t.reviews) : 0}%)`);
  }
  console.log(`Wrote ${path}`);
}

main()
  .then(async () => { await redis.quit().catch(() => undefined); process.exit(0); })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await redis.quit().catch(() => undefined); process.exit(1); });
