import { decode } from 'html-entities';

/**
 * Text clean-up shared by everything that reads review or description HTML
 * from suppliers: the publisher-review extractor and the supplier review
 * splitter script.
 */

/** Windows-1252 characters that arrive as numeric entities in the 128–159 range. */
const CP1252: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹',
  140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™',
  154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

/**
 * Decodes HTML entities, named and numeric. Numeric entities in the 128–159
 * range are read as Windows-1252, which is what the feeds that send them mean:
 * `&#146;` is a right single quote, not a C1 control character.
 */
export function decodeEntities(s: string): string {
  const fixed = s.replace(/&#(\d+);/g, (m, n) => CP1252[Number(n)] ?? m);
  return decode(fixed, { level: 'html5' });
}

const BLOCK_TAG = /<\s*\/?\s*(br|p|li|div|h[1-6]|ul|ol|tr|blockquote)\b[^>]*>/gi;
const ANY_TAG = /<\/?[a-z][^>]*>/gi;

function stripTags(s: string): string {
  return s.replace(BLOCK_TAG, '\n').replace(ANY_TAG, '');
}

/**
 * Readable plain text from supplier HTML, one paragraph per line.
 *
 * Strips and decodes repeatedly, because some ONIX text is entity-encoded
 * markup (`&lt;b&gt;Praise&lt;/b&gt;`), occasionally more than once
 * (`&amp;quot;`): one pass would turn it into tags or entities rather than
 * removing them. Also repairs the SQL-style doubled quotes (`Williams''s`)
 * that leaked into about 2,000 long descriptions in a local sample.
 */
export function toPlainText(html: string): string {
  let text = decodeEntities(stripTags(html));
  for (let i = 0; i < 3 && /&(?:[a-z]+|#\d+|#x[\da-f]+);|<\/?[a-z][^>]*>/i.test(text); i++) {
    text = decodeEntities(stripTags(text));
  }
  return text
    .replace(/'{2,}/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Escapes text for safe inclusion in HTML we generate. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
