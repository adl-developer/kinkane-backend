import { escapeHtml, toPlainText } from './review-text';

/**
 * Pulls review material out of a publisher's ONIX long description.
 *
 * Publishers put press quotes, author blurbs, reader reviews and awards inside
 * the long description, run together with the blurb itself. Gardners' feed has
 * no separate review-quote field (ONIX TextType 08), so this is the only place
 * those quotes reach us. A read-only scan of production on 11 Oct 2026 found
 * them in about 73,000 of 2.04 million descriptions.
 *
 * Everything here is pure: no database, no network. Deterministic rules
 * handle the layouts that can be parsed with confidence, and anything with
 * review signals the rules could not account for is flagged for the LLM
 * (`needsLlm`). Both paths go through the same verbatim validation, so the
 * output can only ever contain text that is in the description.
 */

export type ReviewKind = 'accolade' | 'critic' | 'author' | 'reader';

export interface ReviewItem {
  kind: ReviewKind;
  /** The quoted words without surrounding quote marks, or the accolade line. */
  quote: string;
  /** Who said it, as written in the description. Null for accolades. */
  attribution: string | null;
}

/** An item plus where the rules found it in the normalised text. */
interface FoundItem extends ReviewItem {
  start: number;
  end: number;
}

export interface RulesResult {
  items: ReviewItem[];
  /** True when the text has review signals the rules could not account for. */
  needsLlm: boolean;
  /** The text around the first unaccounted-for signal, for diagnostics. */
  reason?: string;
}

export type ExtractionMethod = 'rules' | 'llm' | 'rules_fallback';

export interface ExtractionResult {
  reviewHtml: string | null;
  items: ReviewItem[];
  method: ExtractionMethod;
}

/** Calls the model; null means the call failed or returned nothing usable. */
export type LlmExtractor = (text: string) => Promise<ReviewItem[] | null>;

// ── Normalising ─────────────────────────────────────────────────────────────

/** The long description as plain text, one paragraph per line. */
export function normaliseDescription(html: string | null | undefined): string {
  return html ? toPlainText(html) : '';
}

// ── Recognising sources ─────────────────────────────────────────────────────

const OPENERS = '“"‘\'';
const CLOSERS: Record<string, string> = { '“': '”"', '"': '"”', '‘': '’\'', "'": "'’" };
/** What may sit just before an opening quote mark: start, space or punctuation. */
const BEFORE_OPEN = /[\s(\[—–\-:;.,!?…*•]/;

/** Words that start a sentence about the book, never a reviewer's name. */
const NOT_A_SOURCE = new Set([
  'i', 'he', 'she', 'they', 'we', 'you', 'it', 'this', 'that', 'there', 'his', 'her', 'my', 'our', 'their',
  'when', 'but', 'and', 'so', 'as', 'in', 'on', 'at', 'one', 'if', 'what', 'now', 'then', 'with', 'for',
  'after', 'before', 'while', 'once', 'here', 'from', 'all', 'every', 'each', 'some', 'its', 'these', 'those',
]);

// Star characters only: a row of asterisks is as often a section break as a rating.
/** Lower-case words that belong in a source line: "author of", "editor at", "in Le Devoir". */
const SOURCE_WORDS = new Set([
  'of', 'the', 'and', 'on', 'in', 'for', 'at', 'from', 'to', 'a', 'an', 'with', 'by', 'de', 'von', 'van', 'la', 'le',
  'du', 'der', 'die', 'das', 'el', 'y', 'author', 'bestselling', 'best-selling', 'award-winning', 'editor', 'founder',
  'co-founder', 'professor', 'winner', 'reviewer', 'review', 'starred', 'writer', 'journalist', 'novelist', 'host',
  'presenter', 'director', 'chair', 'columnist', 'critic', 'creator', 'illustrator', 'poet', 'historian', 'novel',
  'book', 'magazine', 'blogger', 'podcast', 'senior', 'chief', 'emeritus', 'former', 'acclaimed', 'international',
]);

const STAR_RUN = /(?:[★☆⭐]\uFE0F?\s?){3,}|(?:\?\s){4}\?/;
const STAR_RUN_G = new RegExp(STAR_RUN.source, 'g');
const READER_SOURCE = /goodreads|amazon|netgalley|\breader\b|reviewer|customer|book ?blogger|bookstagram|★|⭐/i;
const CRITIC_SOURCE = new RegExp(
  [
    'times', 'guardian', 'observer', 'telegraph', 'independent', 'spectator', 'journal', 'review', 'weekly',
    'magazine', 'post', 'herald', 'tribune', 'mail', 'express', 'kirkus', 'booklist', 'bookseller', 'npr',
    'bbc', 'economist', 'new yorker', 'atlantic', 'vogue', 'elle', 'grazia', 'stylist', 'cosmopolitan',
    'heat', 'metro', 'standard', 'gazette', 'chronicle', 'globe', 'newsweek', 'time out', 'entertainment',
    'usa today', 'buzzfeed', 'publisher', 'library', 'school library', 'horn book', 'bulletin', 'quarterly',
    'press', 'radio', 'tv', 'news', 'scotsman', 'irish', 'evening', 'sunday', 'daily',
  ].map((w) => `\\b${w}\\b`).join('|'),
  'i',
);

/** "Name" or "Name, author of X" — not more prose, not nothing. */
export function looksLikeSource(raw: string, { allowLowercase = false } = {}): boolean {
  const a = raw.replace(/^[\s*\-–—~,(]+|[\s*,)]+$/g, '').trim();
  if (!a) return false;
  const words = a.split(/\s+/);
  if (words.length > 16) return false;
  const first = words[0].replace(/[^\p{L}\p{N}#@]/gu, '');
  if (!first) return STAR_RUN.test(a) || /^[★⭐☆]/.test(a);
  if (NOT_A_SOURCE.has(first.toLowerCase())) return false;
  const startsUpper = /^[\p{Lu}\p{N}#@]/u.test(first);
  if (!startsUpper && !(allowLowercase && READER_SOURCE.test(a))) return false;
  // A full sentence inside it ("…times. Except this time, I…") means prose.
  if (/[.!?]\s+\p{Lu}\p{Ll}+\s+\p{Ll}/u.test(a)) return false;
  if (/(\.\.\.|…|:|\?)$/.test(a)) return false;
  // "…journal from Joan Didion is available now" or "Chernow writes" is a
  // sentence, not a source.
  if (/\b(?:is|are|was|were|has|have|had|will|can|could|would|should|comes|returns|writes|wrote|says|said|notes|argues|explains|observes|recalls|adds)\b/i.test(a) && !READER_SOURCE.test(a)) return false;
  // Too many ordinary lower-case words for a name and affiliation:
  // "Perhaps through these rare prose texts we may…".
  if (!READER_SOURCE.test(a)) {
    const plain = words.filter((w) => /^\p{Ll}/u.test(w) && !SOURCE_WORDS.has(w.toLowerCase().replace(/[^\p{L}-]/gu, '')));
    if (plain.length > 2) return false;
  }
  return true;
}

/**
 * Cuts an attribution where the prose after it begins. "John Green This
 * action-packed novel tackles…" → "John Green". A sentence start is a
 * capitalised word followed by two lower-case ones.
 */
function cutAtProse(s: string): string {
  // [\p{L}] rather than lower-case only: feeds glue words together ("…Crawdads SingFrom the…").
  const m = /\s(?=\p{Lu}[\p{L}’']+\s+\p{Ll}[\p{Ll}-]*\s+\p{Ll})/u.exec(s);
  let out = m ? s.slice(0, m.index) : s;
  // Or at a sentence break: "The Guardian. This book…" (but not initials, "P. D. James").
  const stop = /(?<!\b\p{Lu})[.!?]\s+(?=\p{Lu})/u.exec(out);
  if (stop) out = out.slice(0, stop.index + 1);
  return out.trim();
}

/** An all-caps name at the start of the text: "ADAM HAMDY Born and raised…" → "ADAM HAMDY". */
function leadingCapsName(s: string): string | null {
  const m = /^(\p{Lu}[\p{Lu}.'’-]+(?:\s+\p{Lu}[\p{Lu}.'’-]*){0,4})(?=[\s,;]|$)/u.exec(s);
  if (!m) return null;
  const name = m[1].trim();
  return name.replace(/[^\p{L}]/gu, '').length >= 4 ? name : null;
}

function kindFor(attribution: string | null, context: 'praise' | 'reader' | null, para: string): ReviewKind {
  if (context === 'reader' || (attribution && READER_SOURCE.test(attribution)) || STAR_RUN.test(para)) return 'reader';
  if (attribution && /\b(?:author|novelist|writer|poet|illustrator)\b|bestselling/i.test(attribution)) return 'author';
  if (attribution && CRITIC_SOURCE.test(attribution)) return 'critic';
  return 'author';
}

// ── Headings, separators and accolades ──────────────────────────────────────

const HEADING =
  /^[*\s]*(advance praise|praise|acclaim|critical acclaim|endorsements?|reviews?|testimonials?|what (readers|critics|people|reviewers|the critics|the press) (are saying|say|said)|readers (love|are loving|adore)|reader reviews?|from the reviews|early praise)\b.{0,90}$/i;
const INLINE_HEADING =
  /(?:^|[\s._])(praise for|advance praise|early praise|what (?:readers|critics) (?:are saying|say))\b[^\n]{0,90}?:/i;
const SEPARATOR = /^[\s_\-–—*=~•.]{3,}$/;

function headingContext(p: string): 'praise' | 'reader' | null {
  if (p.length > 120 || !HEADING.test(p)) return null;
  return /reader/i.test(p) ? 'reader' : 'praise';
}

const ACCOLADE_PATTERNS = [
  /^(?:the\s+)?(?:instant\s+)?(?:#\s?1|no\.?\s?1|number one)\b.*\bbestsell/i,
  /^(?:the\s+|an?\s+)?(?:instant\s+|#\s?1\s+)*(?:new york times|sunday times|usa today|wall street journal|times|international|global|instant|million[- ]copy|kindle|amazon)\b.{0,40}\bbestsell(?:er|ing)\b/i,
  /^(?:the\s+)?(?:joint\s+)?(?:winner|won|shortlisted|longlisted|finalist|nominated|selected|named|chosen)\b/i,
  /\b(?:book|pick|choice|read|novel|debut|thriller|memoir|title) of the (?:year|month|week|summer|season)\b/i,
  /\b(?:prize|award|medal)\b.*\b(?:winner|winning|shortlisted|longlisted|finalist|nominee)\b/i,
  /\b(?:winner|winning|shortlisted|longlisted|finalist|nominee)\b.*\b(?:prize|award|medal)\b/i,
  /\bbook club (?:pick|selection|choice)\b|\b(?:reese'?s|oprah'?s|richard (?:and|&) judy|read with jenna)\b.*\bbook club\b/i,
  /\b(?:library guild|indie next|editors'? choice) (?:selection|pick|list)\b/i,
];
const CAPS_ACCOLADE = /BESTSELL|WINNER|PRIZE|AWARD|BOOK OF THE YEAR|SHORTLISTED|LONGLISTED|EDITORS'? CHOICE|SELECTION|#1|NO\. ?1/;

/** An accolade line: an award or bestseller claim about this book, not its author. */
export function isAccolade(segment: string): boolean {
  const s = segment.trim();
  if (s.length < 6 || s.length > 160 || s.split(/\s+/).length > 25) return false;
  if (OPENERS.includes(s[0])) return false;
  // "From the bestselling author of…" praises the author, not this book; an
  // "award-winning" something, a foreword writer's Oscar or a sentence that
  // happens to mention a prize ("It is promised the winner…") are not awards.
  if (/\bauthors?\b|award-winning|prize-winning|\bcreators?\b/i.test(s)) return false;
  if (/^(from|by|the new|a new|the latest|the brand[- ]new|now|foreword|introduction|preface|illustrated|edited|translated|with)\b/i.test(s)) return false;
  const firstWord = s.split(/\s+/)[0].replace(/[^\p{L}]/gu, '').toLowerCase();
  if (NOT_A_SOURCE.has(firstWord) && firstWord !== 'one') return false;
  if (/\?$/.test(s)) return false;
  // A compound like "Carnegie Medal–winning masterwork", or a sentence with a
  // verb in it, describes the book rather than naming an award it won.
  if (/\S[-–]winning\b/i.test(s)) return false;
  if (s.split(/\s+/).length > 8 && /\b(?:is|are|was|were|will|has|have|brings|bring|poised|follows|tells)\b/i.test(s)) return false;
  const letters = s.replace(/[^\p{L}]/gu, '');
  const capsRatio = letters ? letters.replace(/[^\p{Lu}]/gu, '').length / letters.length : 0;
  if (capsRatio >= 0.8 && CAPS_ACCOLADE.test(s)) return true;
  return ACCOLADE_PATTERNS.some((re) => re.test(s));
}

function cleanAccolade(s: string): string {
  // "A Times History Book of the Year: a story which inspired…" → the award only.
  const colon = /:\s+(?=\p{Ll})/u.exec(s);
  const head = colon ? s.slice(0, colon.index) : s;
  return head.replace(/^[\s*•!]+|[\s*•:!]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** Leading accolade segments of a paragraph: "#1 NYT BESTSELLER • More than…" → the first. */
function accoladesIn(p: string, base: number): FoundItem[] {
  const out: FoundItem[] = [];
  const trimmed = p.replace(/^[\s*]+|[\s*]+$/g, '');
  if (trimmed.length <= 160 && isAccolade(cleanAccolade(trimmed))) {
    const start = base + p.indexOf(trimmed.slice(0, 3));
    return [{ kind: 'accolade', quote: cleanAccolade(trimmed), attribution: null, start, end: base + p.length }];
  }
  // Long paragraph: only its opening segments, split on bullets or on sentence
  // ends — but not after an initial ("Winner of the J. Anthony Lukas Prize").
  const boundary = /\s*•\s*|(?<=[\p{Ll}\d)!?][.!?]|[!?])\s+(?=\p{Lu})/gu;
  let from = 0;
  for (;;) {
    boundary.lastIndex = from;
    const m = boundary.exec(p);
    const end = m ? m.index : p.length;
    const seg = cleanAccolade(p.slice(from, end));
    if (!seg || !isAccolade(seg) || seg.split(/\s+/).length > 14) break;
    out.push({ kind: 'accolade', quote: seg, attribution: null, start: base + from, end: base + end });
    if (!m) break;
    from = m.index + m[0].length;
  }
  return out;
}

// ── Quotes ──────────────────────────────────────────────────────────────────

interface QuoteSpan {
  open: number;
  close: number; // index of the closing mark
  inner: string;
}

function quoteFamily(c: string): 'double' | 'single' {
  return '“"'.includes(c) ? 'double' : 'single';
}

function isOpenerAt(p: string, i: number): boolean {
  return OPENERS.includes(p[i]) && (i === 0 || BEFORE_OPEN.test(p[i - 1])) && !/\s/.test(p[i + 1] ?? ' ');
}

/**
 * Every quotation in a paragraph. A quote closes at the first matching mark
 * that is not an apostrophe: a single quote followed by a lower-case letter is
 * inside a word ("won’t"), but "…you’Joan Didion" is a close.
 */
function quotesIn(p: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  let i = 0;
  while (i < p.length) {
    if (!isOpenerAt(p, i)) {
      i++;
      continue;
    }
    const family = quoteFamily(p[i]);
    const closers = CLOSERS[p[i]];
    let close = -1;
    // Depth counts quotes nested inside this one ("…saying to myself 'one
    // more page'. Next…"), so an inner closing mark does not end the outer quote.
    let depth = 0;
    for (let k = i + 2; k < Math.min(p.length, i + 3000); k++) {
      if (isOpenerAt(p, k) && quoteFamily(p[k]) === family) {
        depth++;
        continue;
      }
      if (!closers.includes(p[k])) continue;
      const next = p[k + 1] ?? '';
      if ("'’".includes(p[k]) && /\p{Ll}/u.test(next)) continue;
      if ("'’".includes(p[k]) && /\s/.test(p[k - 1])) continue;
      if (depth > 0) {
        depth--;
        continue;
      }
      close = k;
      break;
    }
    if (close === -1) {
      i++;
      continue;
    }
    const inner = p.slice(i + 1, close).trim();
    if (inner.length >= 3) spans.push({ open: i, close, inner });
    i = close + 1;
  }
  return spans;
}

/** Where the next quotation opens after `from`, or the end of the paragraph. */
function nextOpener(p: string, from: number): number {
  for (let i = from; i < p.length; i++) if (isOpenerAt(p, i)) return i;
  return p.length;
}

function stripQuoteMarks(s: string): string {
  return s.replace(/^[\s“”"‘’']+|[\s“”"‘’']+$/g, '').trim();
}

// ── Signals ─────────────────────────────────────────────────────────────────

/**
 * Patterns that mean "there is probably a review here". Any signal not inside
 * an item the rules extracted sends the description to the LLM.
 */
const SIGNALS: RegExp[] = [
  /[”"’'][.,!?…)]*\s*(?:--|[-–—~])\s*[\p{Lu}@]/gu, // "…" — Source
  /[”"’'][.,!?…]?\s+\p{Lu}{2,}(?:\s+\p{Lu}[\p{Lu}.'’-]+)+/gu, // "…" JILL MANSELL
  /[”"’']\s*\(\s*\p{Lu}[^)]{1,80}\)/gu, // "brilliant" (Lupita Nyong’o, Time)
  /[”"’'][.,!?…]?\s+\p{Lu}\p{Ll}+(?:\s+\p{Lu}[\p{L}.'’-]+){1,3}\s*(?=[“"‘']|$)/gmu, // "…" Lisa Jewell'Next quote
  /[”"’'][.,!?…]?\s+\p{Lu}[\p{L}.'’-]+(?:\s+\p{Lu}[\p{L}.'’-]+){0,3},\s+(?:author|bestselling|winner|editor|founder|professor)\b/gu,
  new RegExp(INLINE_HEADING.source, 'gi'),
  new RegExp(STAR_RUN.source, 'g'),
];

const ENGLISH_WORDS = new Set([
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'that', 'it', 'for', 'with', 'as', 'his', 'her', 'this', 'by',
  'on', 'was', 'are', 'from', 'an', 'be', 'their', 'who', 'you', 'your',
]);

export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 20) return true; // too short to judge; the rules are cheap anyway
  const hits = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  return hits / words.length >= 0.06;
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** The rules pass over normalised text: items found, and whether to ask the LLM. */
export function extractWithRules(text: string): RulesResult {
  const found: FoundItem[] = [];
  const paras: { p: string; base: number }[] = [];
  let offset = 0;
  for (const p of text.split('\n')) {
    paras.push({ p, base: offset });
    offset += p.length + 1;
  }

  let context: 'praise' | 'reader' | null = null;
  const consumed = new Set<number>();

  paras.forEach(({ p, base }, idx) => {
    if (consumed.has(idx) || !p.trim()) return;
    if (SEPARATOR.test(p)) return;

    const heading = headingContext(p);
    if (heading) {
      context = heading;
      found.push({ kind: 'accolade', quote: '', attribution: null, start: base, end: base + p.length }); // marker, dropped below
      return;
    }

    const before = found.length;
    found.push(...accoladesIn(p, base));

    // An inline "Praise for X:" switches on praise context from that point.
    const inline = INLINE_HEADING.exec(p);
    let localContext: 'praise' | 'reader' | null = context;
    if (inline) {
      localContext = /reader/i.test(inline[0]) ? 'reader' : 'praise';
      found.push({ kind: 'accolade', quote: '', attribution: null, start: base + inline.index, end: base + inline.index + inline[0].length });
    }

    let lastEnd = -10;
    for (const q of quotesIn(p)) {
      const afterClose = q.close + 1;
      const lead = /^[.,!?…)\]]*\s*/.exec(p.slice(afterClose))![0].length;
      let attrStart = afterClose + lead;
      const dash = /^(?:--|[-–—~])+\s*/.exec(p.slice(attrStart));
      if (dash) attrStart += dash[0].length;
      const regionEnd = nextOpener(p, attrStart);
      // A next quote glued to the source ("…Review‘Dazzling…", "The Times'My comfort…")
      // has no space before it, so nextOpener misses it; cut there too.
      const region = p.slice(attrStart, regionEnd).split(/[“‘]|(?<=\p{L})['"](?=\p{Lu})/u)[0].trim();

      let attribution: string | null = null;
      const paren = /^\(([^()]{2,100})\)/.exec(region);
      const caps = leadingCapsName(region);
      if (paren) {
        // “brilliant” (Lupita Nyong’o, Time). A single bracketed word is a
        // definition, not a source: “human capital management” (HCM).
        if (looksLikeSource(paren[1]) && paren[1].trim().split(/\s+/).length >= 2) attribution = paren[1].trim();
      } else if (region) {
        const whole = region.replace(/[\s,;]+$/, '');
        // An all-caps name followed by more than an affiliation is a name and
        // then the next sentence: 'Lam vividly draws…' SARAH REES BRENNAN Readers love…
        const capsThenProse =
          caps && caps.split(/\s+/).length >= 2 && whole.length > caps.length && !/^[,;(]/.test(whole.slice(caps.length).trim());
        if (capsThenProse) {
          attribution = caps;
        } else if (looksLikeSource(whole, { allowLowercase: STAR_RUN.test(whole) })) {
          attribution = whole;
        } else if (dash) {
          const cut = cutAtProse(region);
          if (looksLikeSource(cut, { allowLowercase: true })) attribution = cut;
        } else if (caps) {
          attribution = caps;
        }
      } else if (q.open === 0 && regionEnd === p.length) {
        // The whole paragraph is a quote: its source may be the next paragraph.
        const next = paras[idx + 1]?.p ?? '';
        if (next && next.length <= 110 && !OPENERS.includes(next.trim()[0]) && looksLikeSource(next)) {
          const isDashLine = /^[\s]*(?:--|[-–—~])/.test(next);
          if (isDashLine || next.split(/\s+/).length <= 10) {
            attribution = next.replace(/^[\s\-–—~]+/, '').trim();
            consumed.add(idx + 1);
          }
        }
      }

      if (!attribution) {
        // Under a praise heading or beside star ratings a quote may stand alone,
        // but only as one of a run of quotes: a short phrase in quote marks
        // mid-sentence ("family noir") is not a review.
        const vouched = localContext !== null || STAR_RUN.test(p);
        const startsRun = q.open <= 3 || q.open - lastEnd <= 4;
        if (!vouched || !startsRun || q.inner.length < 15 || q.inner.length > 400) continue;
      }

      const attrAt = attribution ? p.indexOf(attribution, afterClose) : -1;
      const attrEnd = attrAt >= 0 ? attrAt + attribution!.length + (paren ? 1 : 0) : afterClose;
      lastEnd = attrEnd;
      found.push({
        kind: kindFor(attribution, localContext, p),
        quote: q.inner,
        attribution: attribution ? attribution.replace(/^[\s\-–—~]+|[\s,]+$/g, '') : null,
        start: base + q.open,
        end: base + Math.max(attrEnd, afterClose),
      });
    }

    // Star-rated reader lines without quotation marks: "★★★★★ Gripping from start to end."
    if (STAR_RUN.test(p) && !found.slice(before).some((f) => f.quote && f.kind !== 'accolade')) {
      const startAt = inline ? inline.index + inline[0].length : 0;
      const body = p.slice(startAt);
      const runs = [...body.matchAll(STAR_RUN_G)];
      runs.forEach((run, i) => {
        const segStart = run.index! + run[0].length;
        const segEnd = i + 1 < runs.length ? runs[i + 1].index! : body.length;
        const seg = body.slice(segStart, segEnd).trim();
        if (seg.length < 10) return;
        const at = base + startAt + segStart;
        found.push({ kind: 'reader', quote: stripQuoteMarks(seg), attribution: null, start: base + startAt + run.index!, end: at + seg.length + 1 });
      });
    }

    const producedReview = found.slice(before).some((f) => f.quote && f.kind !== 'accolade');
    if (!producedReview && !inline) context = null;
  });

  // Routing: any signal outside every found span is something the rules missed.
  const covered = (pos: number) => found.some((f) => pos >= f.start - 3 && pos <= f.end + 3);
  const english = looksEnglish(text);
  let needsLlm = false;
  let reason: string | undefined;
  for (const sig of SIGNALS) {
    sig.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sig.exec(text))) {
      if (!covered(m.index)) {
        needsLlm = true;
        reason = text.slice(Math.max(0, m.index - 40), m.index + 60);
        break;
      }
    }
    if (needsLlm) break;
  }
  // Non-English text: the rules are tuned for English punctuation and phrasing,
  // so a description with quote-and-source shapes in it goes to the model.
  if (!english && !needsLlm && /[”"’'»][.,!?…)]*\s*(?:--|[-–—~])\s*\p{Lu}/u.test(text)) {
    needsLlm = true;
    reason = 'non-English text with a quote and source';
  }

  const items = found.filter((f) => f.quote).map(({ kind, quote, attribution }) => ({ kind, quote, attribution }));
  return { items, needsLlm, reason };
}

// ── Validation ──────────────────────────────────────────────────────────────

function comparable(s: string): string {
  return s
    .replace(/[“”"«»„]/g, '"')
    .replace(/[‘’'‚]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Keeps only items that are really in the description. Applied to rules and
 * LLM output alike; it is what stops a model inventing a quote or a source.
 *
 * - The quote and attribution must both appear verbatim (ignoring quote-mark
 *   style, dash style and whitespace).
 * - A quote needs an attribution, unless the description has a praise heading
 *   or star ratings that vouch for it. Unattributed quotes are otherwise as
 *   likely to be a line from the book.
 * - Duplicates are dropped; accolades sort first.
 */
export function validateItems(items: ReviewItem[], text: string): ReviewItem[] {
  const hay = comparable(text);
  const vouched = text.split('\n').some((p) => headingContext(p) !== null) || INLINE_HEADING.test(text) || STAR_RUN.test(text);
  const seen = new Set<string>();
  const out: ReviewItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw.quote !== 'string') continue;
    const kind: ReviewKind = (['accolade', 'critic', 'author', 'reader'] as const).includes(raw.kind) ? raw.kind : 'author';
    const quote = kind === 'accolade' ? cleanAccolade(raw.quote) : stripQuoteMarks(raw.quote);
    const attribution = kind === 'accolade' ? null : raw.attribution?.replace(/^[\s\-–—~]+|[\s,]+$/g, '').trim() || null;

    if (quote.length < 3 || quote.length > 2000) continue;
    if (!hay.includes(comparable(quote))) continue;
    if (kind === 'accolade') {
      if (!isAccolade(quote)) continue;
    } else if (attribution) {
      if (!hay.includes(comparable(attribution))) continue;
      if (!looksLikeSource(attribution, { allowLowercase: kind === 'reader' })) continue;
    } else if (!vouched) {
      continue;
    }

    const key = comparable(quote);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, quote, attribution });
  }

  return [...out.filter((i) => i.kind === 'accolade'), ...out.filter((i) => i.kind !== 'accolade')];
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * The layout BDS used for review_html, so clients render it the same way:
 * accolades in bold, then "quote" with its source in italics on the next line.
 */
export function toReviewHtml(items: ReviewItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => {
      if (i.kind === 'accolade') return `<b>${escapeHtml(i.quote)}</b>`;
      // '? ? ? ? ?' is a star rating that lost its characters somewhere upstream.
      const source = i.attribution?.replace(/(?:\?\s){4}\?/g, '★★★★★') ?? (i.kind === 'reader' ? 'Reader review' : null);
      return `“${escapeHtml(i.quote)}”${source ? `<br /><i>${escapeHtml(source)}</i>` : ''}`;
    })
    .join('<br /><br />');
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Rules first; the LLM only when the rules saw review signals they could not
 * account for. If the LLM is unavailable or its answer fails validation, the
 * rules' result stands and the method says so (`rules_fallback`), so a later
 * run can retry just those books.
 */
export async function extractPublisherReviews(
  longDescriptionHtml: string | null | undefined,
  llm?: LlmExtractor,
): Promise<ExtractionResult> {
  const text = normaliseDescription(longDescriptionHtml);
  if (!text) return { reviewHtml: null, items: [], method: 'rules' };

  const rules = extractWithRules(text);
  const ruleItems = validateItems(rules.items, text);

  if (!rules.needsLlm) {
    return { reviewHtml: toReviewHtml(ruleItems), items: ruleItems, method: 'rules' };
  }
  if (!llm) {
    return { reviewHtml: toReviewHtml(ruleItems), items: ruleItems, method: 'rules_fallback' };
  }

  const llmRaw = await llm(text);
  const llmItems = llmRaw ? validateItems(llmRaw, text) : [];
  if (llmRaw === null || (llmItems.length === 0 && ruleItems.length > 0)) {
    return { reviewHtml: toReviewHtml(ruleItems), items: ruleItems, method: 'rules_fallback' };
  }
  return { reviewHtml: toReviewHtml(llmItems), items: llmItems, method: 'llm' };
}
