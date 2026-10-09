import { describe, it, expect } from 'vitest';
import {
  DELETED_MENTION,
  MAX_MENTIONS_PER_TEXT,
  extractHandles,
  hasTokens,
  render,
  tokenIds,
  tokenize,
} from '../lib/mention-text';

/**
 * Mention text, in and out. The guarantee that matters most is the round trip:
 * what a client is shown is exactly what it can send back on an edit, and a
 * rename changes how a mention reads without breaking it.
 */

const ids = (entries: [string, number][]) => new Map(entries);
const names = (entries: [number, string][]) => new Map(entries);

describe('extractHandles', () => {
  it('finds each distinct handle once, lowercased, in order', () => {
    expect(extractHandles('@Ama and @kofi, then @ama again')).toEqual(['ama', 'kofi']);
  });

  it('leaves the full stop at the end of a sentence out of the handle', () => {
    expect(extractHandles('Thanks @ama.')).toEqual(['ama']);
    expect(extractHandles('Thanks @ama...')).toEqual(['ama']);
  });

  it('keeps a dot inside a handle', () => {
    expect(extractHandles('ask @ama.reads about it')).toEqual(['ama.reads']);
  });

  it('ignores email addresses', () => {
    expect(extractHandles('write to ama@example.com')).toEqual([]);
  });

  it('accepts a handle after punctuation or at the very start', () => {
    expect(extractHandles('@ama (@kofi) "@esi"')).toEqual(['ama', 'kofi', 'esi']);
  });

  it('skips what cannot be a username', () => {
    expect(extractHandles('@ab is too short and @' + 'x'.repeat(21) + ' too long, @a..b doubled')).toEqual([]);
  });
});

describe('tokenize', () => {
  it('replaces handles that name an account and leaves everything else as typed', () => {
    const out = tokenize('Hey @Ama, have you met @nobody? cc @kofi.', ids([['ama', 1], ['kofi', 2]]));
    expect(out.text).toBe('Hey @{{u:1}}, have you met @nobody? cc @{{u:2}}.');
    expect(out.mentionedIds).toEqual([1, 2]);
  });

  it('links every occurrence but reports each person once', () => {
    const out = tokenize('@ama @ama @AMA', ids([['ama', 1]]));
    expect(out.text).toBe('@{{u:1}} @{{u:1}} @{{u:1}}');
    expect(out.mentionedIds).toEqual([1]);
  });

  it('breaks a token typed by hand, so it cannot pose as a mention nobody was told about', () => {
    const out = tokenize('look: @{{u:5}}', ids([]));
    expect(out.text).toBe('look: @{{ u:5}}');
    expect(hasTokens(out.text)).toBe(false);
    expect(tokenIds(out.text)).toEqual([]);
  });

  it(`links at most ${MAX_MENTIONS_PER_TEXT} distinct people; the rest stay as text`, () => {
    const map = new Map<string, number>();
    const handles: string[] = [];
    for (let i = 1; i <= MAX_MENTIONS_PER_TEXT + 2; i++) {
      map.set(`user${i}x`, i);
      handles.push(`@user${i}x`);
    }
    const out = tokenize(handles.join(' '), map);
    expect(out.mentionedIds).toHaveLength(MAX_MENTIONS_PER_TEXT);
    expect(out.text.endsWith(`@user${MAX_MENTIONS_PER_TEXT + 1}x @user${MAX_MENTIONS_PER_TEXT + 2}x`)).toBe(true);
  });

  it('leaves text with no handles exactly as it was', () => {
    expect(tokenize('Loved it. 5 stars.', ids([])).text).toBe('Loved it. 5 stars.');
  });
});

describe('render', () => {
  it('shows each token as the current username, with its position', () => {
    const out = render('Hey @{{u:1}}, ask @{{u:2}}.', names([[1, 'ama'], [2, 'kofi.reads']]));
    expect(out.text).toBe('Hey @ama, ask @kofi.reads.');
    expect(out.mentions).toEqual([
      { userId: 1, username: 'ama', start: 4, length: 4 },
      { userId: 2, username: 'kofi.reads', start: 14, length: 11 },
    ]);
    for (const m of out.mentions) expect(out.text.slice(m.start, m.start + m.length)).toBe(`@${m.username}`);
  });

  it('follows a rename: the same stored text reads as the new name', () => {
    const stored = 'thanks @{{u:1}}';
    expect(render(stored, names([[1, 'ama_reads']])).text).toBe('thanks @ama_reads');
    expect(render(stored, names([[1, 'ama.reads']])).text).toBe('thanks @ama.reads');
  });

  it('renders a deleted account as plain text, unlinked', () => {
    const out = render('ask @{{u:9}} about it', names([]));
    expect(out.text).toBe(`ask ${DELETED_MENTION} about it`);
    expect(out.mentions).toEqual([]);
  });

  it('counts offsets in UTF-16 units, so emoji before a mention do not shift it', () => {
    const out = render('📚📚 @{{u:1}}', names([[1, 'ama']]));
    const [m] = out.mentions;
    expect(out.text.slice(m.start, m.start + m.length)).toBe('@ama');
    expect(m.start).toBe(5);
  });
});

describe('the round trip', () => {
  it('what a client is shown is what it can send back on an edit', () => {
    const lookup = ids([['ama', 1], ['kofi', 2]]);
    const usernames = names([[1, 'ama'], [2, 'kofi']]);

    const stored = tokenize('Hi @Ama and @kofi.', lookup).text;
    const shown = render(stored, usernames).text;
    expect(shown).toBe('Hi @ama and @kofi.');

    const restored = tokenize(shown, lookup);
    expect(restored.text).toBe(stored);
    expect(restored.mentionedIds).toEqual([1, 2]);
  });
});
