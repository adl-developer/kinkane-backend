import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * How generateExplanations spends its time: how a list is split into Gemini
 * calls, what each call asks for, when it retries, and when it gives up.
 *
 * The quiz response waits on this step, so these pin the behaviour that keeps
 * it fast — exact-count response schema, small parallel chunks, retries without
 * sleeps, and a hard time budget — with the Gemini SDK stubbed.
 */

const generateContent = vi.fn();

vi.mock('@google/generative-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/generative-ai')>()),
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent };
    }
  },
}));

import { generateExplanations, type BookContext } from '../lib/gemini';

const books = (n: number): BookContext[] =>
  Array.from({ length: n }, (_, i) => ({ bookId: i + 1, title: `Book ${i + 1}`, authors: [], genres: [] }));

const idsIn = (request: { contents: { parts: { text: string }[] }[] }) =>
  [...request.contents[0].parts[0].text.matchAll(/^ID:(\d+) \|/gm)].map((m) => Number(m[1]));

const reply = (items: { bookId: number; explanation: string }[]) => ({
  response: { text: () => JSON.stringify(items) },
});

const good = (id: number) => ({ bookId: id, explanation: `{{name}}, you will find book ${id} warm.` });

describe('generateExplanations', () => {
  beforeEach(() => {
    generateContent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('splits 50 books into five parallel calls of ten', async () => {
    generateContent.mockImplementation(async (req) => reply(idsIn(req).map(good)));

    const out = await generateExplanations('prefs', books(50));

    expect(generateContent).toHaveBeenCalledTimes(5);
    for (const [req] of generateContent.mock.calls) expect(idsIn(req)).toHaveLength(10);
    expect(out.every((o) => o.explanation)).toBe(true);
  });

  it('pins the reply to exactly one entry per book in the chunk', async () => {
    generateContent.mockImplementation(async (req) => reply(idsIn(req).map(good)));

    await generateExplanations('prefs', books(13));

    const counts = generateContent.mock.calls.map(([req]) => {
      const schema = req.generationConfig.responseSchema;
      expect(schema.minItems).toBe(schema.maxItems);
      return schema.maxItems;
    });
    expect(counts.sort()).toEqual([10, 3]);
  });

  it('gives every call a timeout and the shared deadline signal', async () => {
    generateContent.mockImplementation(async (req) => reply(idsIn(req).map(good)));

    await generateExplanations('prefs', books(20));

    const options = generateContent.mock.calls.map(([, opts]) => opts);
    expect(options.every((o) => o.timeout > 0 && o.signal instanceof AbortSignal)).toBe(true);
    expect(options[0].signal).toBe(options[1].signal);
  });

  it('retries only the books that came back missing or third person, without sleeping', async () => {
    let call = 0;
    generateContent.mockImplementation(async (req) => {
      call += 1;
      const ids = idsIn(req);
      if (call === 1) {
        // First pass: drops book 2, writes about the reader for book 3.
        return reply([good(1), { bookId: 3, explanation: '{{name}} will love this.' }]);
      }
      return reply(ids.map(good));
    });

    const started = Date.now();
    const out = await generateExplanations('prefs', books(3));

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(idsIn(generateContent.mock.calls[1][0])).toEqual([2, 3]);
    expect(out.map((o) => o.explanation)).toEqual([good(1), good(2), good(3)].map((g) => g.explanation));
    // The old loop slept 2s+ between rounds.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('chunks the retry round the same way as the first pass', async () => {
    let call = 0;
    generateContent.mockImplementation(async (req) => {
      call += 1;
      return call <= 3 ? reply([]) : reply(idsIn(req).map(good));
    });

    await generateExplanations('prefs', books(30));

    const retrySizes = generateContent.mock.calls.slice(3).map(([req]) => idsIn(req).length);
    expect(retrySizes).toEqual([10, 10, 10]);
  });

  it('returns what it has once the time budget runs out, instead of waiting', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);

    generateContent.mockImplementation((req, opts: { signal: AbortSignal }) => {
      const ids = idsIn(req);
      // Book 1's chunk answers; the other hangs until the deadline aborts it.
      if (ids.includes(1)) return Promise.resolve(reply(ids.map(good)));
      return new Promise((_, reject) =>
        opts.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });

    const pending = generateExplanations('prefs', books(15));
    setTimeout(() => deadline.abort(), 20);
    const out = await pending;

    expect(out.slice(0, 10).every((o) => o.explanation)).toBe(true);
    expect(out.slice(10).every((o) => o.explanation === '')).toBe(true);
    // Neither withRetry nor the fallback model nor a retry round ran after the abort.
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});
