import { describe, it, expect } from 'vitest';
import {
  MAX_LINKS_PER_TEXT,
  addressSpans,
  domainCandidates,
  normalizeDomain,
  shownLength,
  MISSING_LINK,
  domainOf,
  findUrls,
  hasLinkTokens,
  linkTokenIds,
  neutralizeLinkTokens,
  normalizeUrl,
  renderLinks,
  shiftOffsets,
  shortLinkCode,
  tokenizeLinks,
  type FoundUrl,
  type StoredLink,
} from '../lib/link-text';
import { render } from '../lib/mention-text';

/**
 * Link text, in and out. As with mentions, the guarantee that matters most is
 * the round trip: the short link a client is shown is what it sends back on an
 * edit, and that maps to the same stored link.
 */

const PREFIX = 'https://www.kinkane.app/s';
const HOSTS = ['www.kinkane.app', 'kinkane.app'];
const typed = (text: string) => findUrls(text).map((f) => text.slice(f.start, f.start + f.length));

describe('findUrls', () => {
  it('finds http, https and www addresses', () => {
    expect(typed('a http://a.com b https://b.org/x c www.c.net/y')).toEqual([
      'http://a.com',
      'https://b.org/x',
      'www.c.net/y',
    ]);
  });

  it('gives www addresses a scheme when normalising', () => {
    expect(findUrls('see www.example.com')[0].url).toBe('https://www.example.com/');
  });

  it('leaves sentence punctuation out of the address', () => {
    expect(typed('Read https://a.com/x. Then https://b.com/y, and https://c.com/z!')).toEqual([
      'https://a.com/x',
      'https://b.com/y',
      'https://c.com/z',
    ]);
  });

  it('drops a closing bracket the address did not open', () => {
    expect(typed('(see https://a.com/x)')).toEqual(['https://a.com/x']);
  });

  it('keeps a bracket the address opened itself', () => {
    expect(typed('https://en.wikipedia.org/wiki/Dune_(novel).')).toEqual(['https://en.wikipedia.org/wiki/Dune_(novel)']);
  });

  it('stops at quotes and angle brackets', () => {
    expect(typed('"https://a.com/x" <https://b.com>')).toEqual(['https://a.com/x', 'https://b.com']);
  });

  it('does not treat bare words or a scheme mid-word as addresses', () => {
    expect(typed('example and foohttps://a.com')).toEqual([]);
  });

  it('finds bare names ending in .com, .net, .org or .co.uk', () => {
    expect(typed('try google.com, bbc.co.uk/news and Wikipedia.org/wiki/Dune. or x.net?')).toEqual([
      'google.com',
      'bbc.co.uk/news',
      'Wikipedia.org/wiki/Dune',
      'x.net',
    ]);
    expect(findUrls('see goodreads.com/book/1')[0].url).toBe('https://goodreads.com/book/1');
  });

  it('leaves other bare endings, longer names and email addresses alone', () => {
    expect(typed('example.io google.com.au x.community ama@gmail.com @ama.com sub-x.com.')).toEqual(['sub-x.com']);
    expect(typed('archive.org/web and www.archive.org')).toEqual(['archive.org/web', 'www.archive.org']);
  });

  it('splits a pasted markdown link at its square brackets', () => {
    expect(typed('[www.google.com](https://www.google.com)')).toEqual(['www.google.com', 'https://www.google.com']);
  });

  it('leaves out the curly quotes phone keyboards type around an address', () => {
    expect(typed('Read \u201chttps://x.com/a\u201d now')).toEqual(['https://x.com/a']);
    expect(typed('\u2018https://x.com/b\u2019')).toEqual(['https://x.com/b']);
    expect(typed('\u00abhttps://x.com/c\u00bb')).toEqual(['https://x.com/c']);
  });

  it('ends an address at an ellipsis or an emoji typed straight after it', () => {
    expect(typed('https://x.com/a\u2026 and https://x.com/b\ud83d\udd25\ud83d\udd25')).toEqual(['https://x.com/a', 'https://x.com/b']);
    expect(findUrls('https://x.com/a\u2764\ufe0f')[0].url).toBe('https://x.com/a');
  });

  it('leaves out full-width punctuation', () => {
    expect(typed('\u770b https://x.com/a\u3002')).toEqual(['https://x.com/a']);
  });

  it('keeps letters with accents in a path', () => {
    expect(findUrls('https://fr.wikipedia.org/wiki/\u00c9t\u00e9.')[0].url).toBe('https://fr.wikipedia.org/wiki/%C3%89t%C3%A9');
  });

  it('measures offsets in UTF-16 code units', () => {
    const text = '📚 https://a.com';
    expect(findUrls(text)[0].start).toBe(3);
  });
});

describe('findUrls with our own base', () => {
  it('finds our short links even on a host without a dot', () => {
    const dev = ['localhost:3000'];
    expect(findUrls('see http://localhost:3000/l/AB12CD34.', dev)).toEqual([
      { start: 4, length: 'http://localhost:3000/l/AB12CD34'.length, url: 'http://localhost:3000/l/AB12CD34' },
    ]);
    expect(findUrls('see http://localhost:3000/books', dev)).toEqual([]);
  });
});

describe('normalizeUrl', () => {
  it('refuses other schemes', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://a.com')).toBeNull();
  });

  it('refuses a host without a dot', () => {
    expect(normalizeUrl('http://localhost:3000')).toBeNull();
  });

  it('refuses addresses carrying a user name, which can disguise where they go', () => {
    expect(normalizeUrl('https://bank.com@evil.example/login')).toBeNull();
  });

  it('refuses addresses over the length limit', () => {
    expect(normalizeUrl(`https://a.com/${'x'.repeat(2100)}`)).toBeNull();
  });
});

describe('shortLinkCode', () => {
  it('recognises our own short links, whatever the case', () => {
    expect(shortLinkCode('https://www.kinkane.app/s/ab12cd34', HOSTS)).toBe('AB12CD34');
    expect(shortLinkCode('https://www.kinkane.app/s/AB12CD34/', HOSTS)).toBe('AB12CD34');
  });

  it('still recognises the original /l/ form, so older links keep the same link on edit', () => {
    expect(shortLinkCode('https://www.kinkane.app/s/AB12CD34', HOSTS)).toBe('AB12CD34');
  });

  it('treats www and the bare domain as the same site', () => {
    expect(shortLinkCode('https://kinkane.app/s/AB12CD34', ['www.kinkane.app'])).toBe('AB12CD34');
    expect(shortLinkCode('www.kinkane.app/s/AB12CD34', ['kinkane.app'])).toBe('AB12CD34');
  });

  it('ignores other hosts and other paths', () => {
    expect(shortLinkCode('https://evil.example/s/AB12CD34', HOSTS)).toBeNull();
    expect(shortLinkCode('https://kinkane.app.evil.example/s/AB12CD34', HOSTS)).toBeNull();
    expect(shortLinkCode('https://kinkane.app/r/AB12CD34', HOSTS)).toBeNull();
    expect(shortLinkCode('https://kinkane.app/s/AB12CD34?x=1', HOSTS)).toBeNull();
    expect(shortLinkCode('https://kinkane.app/s/AB12CD34', [])).toBeNull();
  });
});

describe('tokenizeLinks', () => {
  const byUrl = (map: Record<string, number>) => (f: FoundUrl) => map[f.url];

  it('replaces each resolved address with its token, keeping the punctuation', () => {
    const text = 'Read https://a.com/x.';
    const result = tokenizeLinks(text, findUrls(text), byUrl({ 'https://a.com/x': 7 }));
    expect(result).toEqual({ text: 'Read {{l:7}}.', linkIds: [7] });
  });

  it('leaves addresses that did not resolve as typed', () => {
    const text = 'https://a.com and https://b.com';
    const result = tokenizeLinks(text, findUrls(text), byUrl({ 'https://b.com/': 2 }));
    expect(result.text).toBe('https://a.com and {{l:2}}');
  });

  it('links at most MAX_LINKS_PER_TEXT distinct addresses, repeats included', () => {
    const urls = Array.from({ length: MAX_LINKS_PER_TEXT + 2 }, (_, i) => `https://s${i}.com/`);
    const text = [...urls, urls[0]].join(' ');
    const ids = Object.fromEntries(urls.map((u, i) => [u, i + 1]));
    const result = tokenizeLinks(text, findUrls(text), byUrl(ids));
    expect(result.linkIds).toHaveLength(MAX_LINKS_PER_TEXT);
    expect(result.text.endsWith('{{l:1}}')).toBe(true);
    expect(result.text).toContain(urls[MAX_LINKS_PER_TEXT]);
  });

  it('cannot be tricked by a token typed by hand', () => {
    const safe = neutralizeLinkTokens('see {{l:5}}');
    expect(hasLinkTokens(safe)).toBe(false);
    expect(linkTokenIds(safe)).toEqual([]);
  });
});

describe('renderLinks', () => {
  const links = new Map<number, StoredLink>([
    [7, { code: 'AB12CD34', url: 'https://www.goodreads.com/book/1', blocked: false }],
    [8, { code: 'ZZ99ZZ99', url: 'https://evil.example/', blocked: true }],
  ]);

  it('shows each token as its short link, with where it goes', () => {
    const out = renderLinks('Read {{l:7}}.', links, PREFIX);
    expect(out.text).toBe('Read https://www.kinkane.app/s/AB12CD34.');
    expect(out.links).toEqual([
      {
        url: 'https://www.kinkane.app/s/AB12CD34',
        target: 'https://www.goodreads.com/book/1',
        domain: 'goodreads.com',
        blocked: false,
        start: 5,
        length: 'https://www.kinkane.app/s/AB12CD34'.length,
      },
    ]);
  });

  it('withholds the target of a blocked link', () => {
    const [ref] = renderLinks('{{l:8}}', links, PREFIX).links;
    expect(ref).toMatchObject({ blocked: true, target: null, domain: null });
  });

  it('renders a token with no row as plain text, unlinked', () => {
    const out = renderLinks('x {{l:99}}', links, PREFIX);
    expect(out).toMatchObject({ text: `x ${MISSING_LINK}`, links: [] });
  });

  it('round-trips: the rendered short link resolves back to the same stored link', () => {
    const shown = renderLinks('{{l:7}}', links, PREFIX).text;
    const [found] = findUrls(shown);
    expect(shortLinkCode(found.url, HOSTS)).toBe('AB12CD34');
  });
});

describe('addressSpans', () => {
  it('covers every address-shaped run, linked or not', () => {
    const text = 'x https://medium.com/@ama/review, y';
    const [[start, end]] = addressSpans(text);
    expect(text.slice(start, end)).toBe('https://medium.com/@ama/review');
  });
});

describe('mentions and links in the same text', () => {
  it('moves mention offsets to match the rendered links', () => {
    const stored = '{{l:7}} by @{{u:3}}';
    const m = render(stored, new Map([[3, 'ama']]));
    const l = renderLinks(m.text, new Map([[7, { code: 'AB12CD34', url: 'https://a.com/', blocked: false }]]), PREFIX);
    const mentions = shiftOffsets(m.mentions, l.shifts);
    expect(l.text).toBe('https://www.kinkane.app/s/AB12CD34 by @ama');
    expect(l.text.slice(mentions[0].start, mentions[0].start + mentions[0].length)).toBe('@ama');
    expect(l.text.slice(l.links[0].start, l.links[0].start + l.links[0].length)).toBe('https://www.kinkane.app/s/AB12CD34');
  });
});

describe('domainOf', () => {
  it('drops a leading www', () => {
    expect(domainOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });
});

describe('shownLength', () => {
  it('counts each link token at the short-link length', () => {
    expect(shownLength('a {{l:7}} b {{l:12}}', 34)).toBe('a  b '.length + 34 * 2);
    expect(shownLength('no links', 34)).toBe(8);
  });
});

describe('domain blocking helpers', () => {
  it('normalises a domain the way the block list stores it', () => {
    expect(normalizeDomain('WWW.Evil.Example')).toBe('evil.example');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('evil.example/path')).toBe('evil.example');
    expect(normalizeDomain('not a domain')).toBeNull();
  });

  it('lists the host and every parent domain, but not the bare TLD', () => {
    expect(domainCandidates('https://login.evil.example/x?a=1')).toEqual(['login.evil.example', 'evil.example']);
    expect(domainCandidates('https://www.bbc.co.uk/')).toEqual(['www.bbc.co.uk', 'bbc.co.uk', 'co.uk']);
  });
});
