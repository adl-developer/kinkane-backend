import { describe, it, expect, vi } from 'vitest';
import {
  extractPublisherReviews,
  extractWithRules,
  isAccolade,
  normaliseDescription,
  toReviewText,
  validateItems,
  type ReviewItem,
} from '../lib/publisher-reviews';

// Fixtures are modelled on real Gardners long descriptions found while sizing
// this work (local catalogue, Oct 2026), trimmed to the part that matters.

function rules(html: string) {
  const text = normaliseDescription(html);
  const res = extractWithRules(text);
  return { ...res, items: validateItems(res.items, text) };
}

const quotes = (items: ReviewItem[]) => items.filter((i) => i.kind !== 'accolade');

describe('normaliseDescription', () => {
  it('strips entity-encoded markup, not just real tags', () => {
    expect(normaliseDescription('&lt;b&gt;Praise&lt;/b&gt;&lt;br&gt;Second')).toBe('Praise\nSecond');
  });

  it('keeps decoding text that was entity-encoded more than once', () => {
    expect(normaliseDescription('Margaret Wheatley, author of &amp;quot;Leadership&amp;quot;')).toBe(
      'Margaret Wheatley, author of "Leadership"',
    );
  });

  it('repairs SQL-style doubled quotes from the feed', () => {
    expect(normaliseDescription("Tennessee Williams''s play")).toBe("Tennessee Williams's play");
  });

  it('reads Windows-1252 numeric entities as the quotes they are', () => {
    expect(normaliseDescription('&#145;Gripping&#146; Guardian')).toBe('‘Gripping’ Guardian');
  });
});

describe('extractWithRules: quotes', () => {
  it('splits a dash attribution from the blurb that follows it', () => {
    const { items } = rules(
      '"A gripping, visceral, and hold-your-breath intense story." - John Green This action-packed novel tackles topics both timely and timeless.',
    );
    expect(items).toEqual([
      { kind: 'author', quote: 'A gripping, visceral, and hold-your-breath intense story.', attribution: 'John Green' },
    ]);
  });

  it('reads one quote per paragraph with an all-caps source', () => {
    const { items } = rules(
      "<p>'Rebecca Serle is a maestro of love in all its forms' GABRIELLE ZEVIN</p>" +
        "<p>'A clever, immersive novel - gorgeous!' CESCA MAJOR, author of Maybe Next Time</p>" +
        "<p>When Katy's mother dies, she's left reeling from the loss.</p>",
    );
    expect(items.map((i) => i.attribution)).toEqual(['GABRIELLE ZEVIN', 'CESCA MAJOR, author of Maybe Next Time']);
  });

  it('stops an all-caps source where the next sentence starts', () => {
    const { items } = rules("'Lam vividly draws a tale like no other' SARAH REES BRENNAN Readers love SHADOWPLAY!");
    expect(items[0].attribution).toBe('SARAH REES BRENNAN');
  });

  it('takes a source in brackets and leaves the prose after it', () => {
    const { items } = rules(
      'A “brilliant” (Lupita Nyong’o, Time), “soul-nourishing” (USA Today) memoir about coming of age during apartheid',
    );
    expect(quotes(items)).toEqual([
      { kind: 'author', quote: 'brilliant', attribution: 'Lupita Nyong’o, Time' },
      { kind: 'critic', quote: 'soul-nourishing', attribution: 'USA Today' },
    ]);
  });

  it('does not take a bracketed acronym as a source', () => {
    expect(rules('The rise of “human capital management” (HCM) has changed how firms hire.').items).toEqual([]);
  });

  it('keeps a nested quote inside the review it belongs to', () => {
    const { items } = rules(
      "'I kept saying to myself 'one more page'. What a wild ride!' coffeeandpages2021, ⭐️⭐️⭐️⭐️⭐️",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'reader', attribution: 'coffeeandpages2021, ⭐️⭐️⭐️⭐️⭐️' });
    expect(items[0].quote).toContain('What a wild ride!');
  });

  it('finds an attributed quote at the end of a prose paragraph, after an excerpt', () => {
    const { items } = rules(
      "'I used to love swimming. Won medals for it.'Cameron is thirteen, and all he wants is to be normal. " +
        "'A powerful story about friendship, loyalty and family' Guardian on the novel Pig Heart Boy",
    );
    expect(items).toEqual([
      {
        kind: 'critic',
        quote: 'A powerful story about friendship, loyalty and family',
        attribution: 'Guardian on the novel Pig Heart Boy',
      },
    ]);
  });

  it('cuts a source where the next quote is glued on without a space', () => {
    const { items } = rules('<p>‘I throughly recommend this novel’ Historical Novels Review‘Dazzling’ The Times</p>');
    expect(items[0].attribution).toBe('Historical Novels Review');
  });
});

describe('extractWithRules: things that are not reviews', () => {
  it('ignores an opening line quoted from the book', () => {
    expect(rules("<p>'My name is Darcy, I'm your nurse. I'm here to help you.' I repeat the words I've said so many times.</p>").items).toEqual([]);
  });

  it('ignores a whole blurb that happens to sit in quote marks', () => {
    expect(rules('"When Margaret Thursday lands a role as a child actress, news of her success reaches her bitter enemy."').items).toEqual([]);
  });

  it('ignores a quote whose "source" is a sentence', () => {
    expect(rules("'To repudiate his legacy,' Chernow writes, 'is to repudiate the modern world.'").items).toEqual([]);
    expect(rules('‘attempt to make sense of the weeks’ *Notes to John, the journal from Joan Didion is available now*').items).toEqual([]);
  });

  it('treats a row of asterisks as a section break, not a star rating', () => {
    const { items } = rules(
      "<p>‘Addictive and brilliant’ Lisa Jewell</p><p>*****</p><p>Be afraid. Someone’s watching.</p><p>At fifteen, Amy witnessed her father brutally murder his secret lover.</p>",
    );
    expect(items).toEqual([{ kind: 'author', quote: 'Addictive and brilliant', attribution: 'Lisa Jewell' }]);
  });

  it('does not take a scare quote inside a praise section as a review', () => {
    const { items } = rules('<p>Praise for Adele Parks:</p><p>No-one does ‘family noir’ quite like Adele Parks — T. M. Logan</p>');
    expect(items.map((i) => i.quote)).not.toContain('family noir');
  });
});

describe('extractWithRules: reader reviews and headings', () => {
  it('splits star-rated reader lines that lost their quote marks', () => {
    const { items } = rules(
      'The past never stays buried.____Praise for the Cydney Granger Thriller Series:? ? ? ? ? I was hooked within the first 2 chapters. ? ? ? ? ? Gripped from beginning to end.',
    );
    expect(items).toEqual([
      { kind: 'reader', quote: 'I was hooked within the first 2 chapters.', attribution: null },
      { kind: 'reader', quote: 'Gripped from beginning to end.', attribution: null },
    ]);
  });

  it('accepts quotes listed under a "what readers are saying" heading', () => {
    const { items } = rules(
      "<p>What readers are saying about The Perfect Nurse:</p><p>'Absolutely jaw-dropping... WOW!' Goodreads reviewer, ⭐⭐⭐⭐⭐</p>",
    );
    expect(items).toEqual([{ kind: 'reader', quote: 'Absolutely jaw-dropping... WOW!', attribution: 'Goodreads reviewer, ⭐⭐⭐⭐⭐' }]);
  });
});

describe('accolades', () => {
  it('recognises awards and bestseller claims about the book', () => {
    for (const s of [
      '#1 NEW YORK TIMES BESTSELLER',
      'Winner of the Thurber Prize for American Humor',
      'Shortlisted for the Rathbones Folio Prize',
      'A Times History Book of the Year',
      'A BBC RADIO 2 BOOK CLUB PICK',
      'NAMED ONE OF THE BEST BOOKS OF THE YEAR BY THE WASHINGTON POST',
    ]) {
      expect(isAccolade(s), s).toBe(true);
    }
  });

  it('rejects praise of the author and sentences that mention a prize', () => {
    for (const s of [
      'From the million-copy Sunday Times bestselling author comes a heartwarming story',
      'It is promised the winner will receive a fortune, but there is only one prize Mei wants: revenge.',
      'Patrick Ness’s Carnegie Medal–winning masterwork is poised to attract a crossover audience.',
      'For readers of David Grann’s award-winning Killers of the Flower Moon',
      'Foreword by Doug Chiang, Lucasfilm VP and Academy Award winner',
      'Phillipa Ashley, Sunday Times bestseller, November 2023',
    ]) {
      expect(isAccolade(s), s).toBe(false);
    }
  });

  it('takes the leading accolades of a long paragraph and stops at the blurb', () => {
    const { items } = rules(
      '#1 NEW YORK TIMES BESTSELLER • Winner of the J. Anthony Lukas Prize • A searing portrait of a family that refuses to give up on each other over three decades.',
    );
    expect(items.filter((i) => i.kind === 'accolade').map((i) => i.quote)).toEqual([
      '#1 NEW YORK TIMES BESTSELLER',
      'Winner of the J. Anthony Lukas Prize',
    ]);
  });

  it('drops the prose after an award introduced with a colon', () => {
    const { items } = rules('<p>A Times History Book of the Year: a story which inspired the Hollywood film.</p>');
    expect(items).toEqual([{ kind: 'accolade', quote: 'A Times History Book of the Year', attribution: null }]);
  });
});

describe('routing', () => {
  it('sends a review signal the rules could not account for to the LLM', () => {
    const res = rules("Get HOOKED on this thriller!'I couldn't take my eyes off it' Janice Hallett'Addictive and brilliant' Lisa Jewell");
    expect(res.needsLlm).toBe(true);
  });

  it('keeps clean layouts away from the LLM', () => {
    expect(rules("<p>'Delightful' Veronica Henry</p><p>From the moment Lily arrives…</p>").needsLlm).toBe(false);
    expect(rules('<p>A quiet story about a family farm.</p>').needsLlm).toBe(false);
  });
});

describe('validateItems', () => {
  const text = "'Gripping from start to finish' Jill Mansell\nA story about a lighthouse.";

  it('drops quotes and sources that are not in the description', () => {
    const out = validateItems(
      [
        { kind: 'author', quote: 'Gripping from start to finish', attribution: 'Jill Mansell' },
        { kind: 'critic', quote: 'A masterpiece', attribution: 'The Guardian' },
        { kind: 'author', quote: 'Gripping from start to finish', attribution: 'Marian Keyes' },
      ],
      text,
    );
    expect(out).toEqual([{ kind: 'author', quote: 'Gripping from start to finish', attribution: 'Jill Mansell' }]);
  });

  it('drops an unattributed quote unless a heading or stars vouch for it', () => {
    expect(validateItems([{ kind: 'author', quote: 'A story about a lighthouse.', attribution: null }], text)).toEqual([]);
  });

  it('ignores quote-mark and dash style when matching', () => {
    const out = validateItems([{ kind: 'author', quote: '“Gripping from start to finish”', attribution: '— Jill Mansell' }], text);
    expect(out).toEqual([{ kind: 'author', quote: 'Gripping from start to finish', attribution: 'Jill Mansell' }]);
  });
});

describe('toReviewText', () => {
  it('is plain text: awards first, then each quote with its source on the next line', () => {
    expect(
      toReviewText([
        { kind: 'accolade', quote: 'Winner of the Costa Prize', attribution: null },
        { kind: 'critic', quote: 'Witty & wise', attribution: 'The Times' },
        { kind: 'reader', quote: 'Loved it', attribution: '? ? ? ? ?' },
        { kind: 'reader', quote: 'Could not put it down', attribution: null },
      ]),
    ).toBe(
      'Winner of the Costa Prize\n\n“Witty & wise”\n— The Times\n\n“Loved it”\n— ★★★★★\n\n“Could not put it down”\n— Reader review',
    );
  });

  it('returns null when there is nothing to show', () => {
    expect(toReviewText([])).toBeNull();
  });
});

describe('extractPublisherReviews', () => {
  const clean = "<p>'Delightful' Veronica Henry</p><p>From the moment Lily arrives…</p>";
  const messy = "Get HOOKED on this thriller!'I couldn't take my eyes off it' Janice Hallett'Addictive and brilliant' Lisa Jewell";

  it('does not call the LLM when the rules are confident', async () => {
    const llm = vi.fn();
    const res = await extractPublisherReviews(clean, llm);
    expect(llm).not.toHaveBeenCalled();
    expect(res).toMatchObject({ method: 'rules', reviewText: '“Delightful”\n— Veronica Henry' });
  });

  it('uses validated LLM items when the rules hand over', async () => {
    const llm = vi.fn().mockResolvedValue([
      { kind: 'author', quote: "I couldn't take my eyes off it", attribution: 'Janice Hallett' },
      { kind: 'author', quote: 'Addictive and brilliant', attribution: 'Lisa Jewell' },
      { kind: 'critic', quote: 'Invented praise', attribution: 'The Times' },
    ]);
    const res = await extractPublisherReviews(messy, llm);
    expect(res.method).toBe('llm');
    expect(res.items.map((i) => i.attribution)).toEqual(['Janice Hallett', 'Lisa Jewell']);
  });

  it('falls back to the rules when the LLM fails, and says so', async () => {
    const res = await extractPublisherReviews(messy, vi.fn().mockResolvedValue(null));
    expect(res.method).toBe('rules_fallback');
  });

  it('marks the result as a fallback when no LLM is available', async () => {
    expect((await extractPublisherReviews(messy)).method).toBe('rules_fallback');
  });

  it('returns nothing for an empty description', async () => {
    expect(await extractPublisherReviews(null)).toEqual({ reviewText: null, items: [], method: 'rules' });
  });
});
