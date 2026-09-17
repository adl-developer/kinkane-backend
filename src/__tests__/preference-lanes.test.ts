import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What generatePreferenceVector actually sends to Gemini and actually returns.
 *
 * preference-weights.test.ts pins the vector maths and a few source-level
 * contracts. These run the real lane-building code with Gemini and the database
 * stubbed, so they can say what happens rather than what the source contains:
 * which lanes cost an embedding call, which vector the books lane is built
 * from, and what the fallbacks do.
 *
 * Vectors are four-dimensional and axis-aligned so the expected result of any
 * combination can be read straight off the components.
 */

vi.mock('../lib/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/gemini')>()),
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  generateExplanations: vi.fn(),
}));

vi.mock('../db', () => ({ db: {} }));

vi.mock('../lib/redis', () => ({
  redis: {
    get: async () => null,
    set: () => ({ catch: () => undefined }),
    del: async () => 1,
  },
}));

const A = [1, 0, 0, 0];
const B = [0, 1, 0, 0];
const C = [0, 0, 1, 0];
const D = [0, 0, 0, 1];

const INPUT = {
  feelings: ['comforted', 'hopeful'],
  genres: ['romance', 'crime'],
  dislikes: {},
};

type Weights = { books: number; feelings: number; genres: number; dislikes: number; tags: number };

/**
 * Boots the service against a given switch and weighting. Weights are always
 * given in full and always total 100, so these tests hold whether or not the
 * config enforces that.
 */
async function load(opts: { booksFromEmbeddings: boolean; weights: Weights }) {
  vi.resetModules();
  vi.stubEnv('RECO_WEIGHTING_ENABLED', 'true');
  vi.stubEnv('RECO_BOOKS_FROM_EMBEDDINGS', String(opts.booksFromEmbeddings));
  vi.stubEnv('RECO_SIMILARITY_MAX', '0.25');
  vi.stubEnv('RECO_BACKFILL_MAX', '0.32');
  vi.stubEnv('RECO_WEIGHT_BOOKS', String(opts.weights.books));
  vi.stubEnv('RECO_WEIGHT_FEELINGS', String(opts.weights.feelings));
  vi.stubEnv('RECO_WEIGHT_GENRES', String(opts.weights.genres));
  vi.stubEnv('RECO_WEIGHT_DISLIKES', String(opts.weights.dislikes));
  vi.stubEnv('RECO_WEIGHT_TAGS', String(opts.weights.tags));

  const service = await import('../services/recommendations.service');
  const gemini = await import('../lib/gemini');
  return {
    generatePreferenceVector: service.generatePreferenceVector,
    generateEmbeddings: vi.mocked(gemini.generateEmbeddings),
    generateEmbedding: vi.mocked(gemini.generateEmbedding),
  };
}

const only = (lane: keyof Weights): Weights => ({
  books: 0,
  feelings: 0,
  genres: 0,
  dislikes: 0,
  tags: 0,
  [lane]: 100,
});

function expectDirection(actual: number[], expected: number[]) {
  const mag = Math.sqrt(expected.reduce((a, n) => a + n * n, 0));
  expect(actual).toHaveLength(expected.length);
  expected.forEach((n, i) => expect(actual[i]).toBeCloseTo(n / mag, 10));
}

beforeEach(() => {
  // The mocked Gemini functions survive resetModules, and restoreAllMocks does
  // not clear a vi.fn's call history — without this, one test's embedding call
  // shows up as a call in the next.
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('books lane from stored embeddings', () => {
  it('searches on the centre of the named books, without an embedding call', async () => {
    const { generatePreferenceVector, generateEmbeddings, generateEmbedding } = await load({
      booksFromEmbeddings: true,
      weights: only('books'),
    });

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'First', authors: ['X'], embedding: A },
      { id: 2, title: 'Second', authors: ['Y'], embedding: B },
    ]);

    expectDirection(vector, [1, 1, 0, 0]);
    // The whole point: the catalogue already embedded these books.
    expect(generateEmbeddings).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('gives a book with a longer vector no more say than any other', async () => {
    const { generatePreferenceVector } = await load({ booksFromEmbeddings: true, weights: only('books') });

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'Wordy blurb', authors: [], embedding: [40, 0, 0, 0] },
      { id: 2, title: 'Two lines', authors: [], embedding: B },
    ]);

    expectDirection(vector, [1, 1, 0, 0]);
  });

  it('sends only the lanes that are still words to Gemini', async () => {
    const { generatePreferenceVector, generateEmbeddings } = await load({
      booksFromEmbeddings: true,
      weights: { books: 50, feelings: 50, genres: 0, dislikes: 0, tags: 0 },
    });
    generateEmbeddings.mockResolvedValue([C]);

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'First', authors: ['X'], embedding: A },
    ]);

    expect(generateEmbeddings).toHaveBeenCalledTimes(1);
    const [texts] = generateEmbeddings.mock.calls[0];
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^I want to feel:/);
    expect(texts.join(' ')).not.toContain('Books I have enjoyed');
    // Equal shares of the books centre (A) and the feelings embedding (C).
    expectDirection(vector, [1, 0, 1, 0]);
  });

  it('leaves out a book still waiting for its embedding, rather than blocking', async () => {
    const { generatePreferenceVector, generateEmbeddings } = await load({
      booksFromEmbeddings: true,
      weights: only('books'),
    });

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'Embedded', authors: [], embedding: A },
      { id: 2, title: 'Not yet', authors: [], embedding: null },
    ]);

    expectDirection(vector, [1, 0, 0, 0]);
    expect(generateEmbeddings).not.toHaveBeenCalled();
  });

  it('falls back to naming the titles when none of the books are embedded', async () => {
    const { generatePreferenceVector, generateEmbeddings } = await load({
      booksFromEmbeddings: true,
      weights: only('books'),
    });
    generateEmbeddings.mockResolvedValue([D]);

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'Albion', authors: ['Anna Hope'], embedding: null },
      { id: 2, title: 'Bad Cree', authors: [], embedding: undefined },
    ]);

    expect(generateEmbeddings).toHaveBeenCalledWith([
      'Books I have enjoyed: "Albion" by Anna Hope; "Bad Cree".',
    ]);
    expectDirection(vector, D);
  });

  it('keeps naming the titles while the switch is off, even for embedded books', async () => {
    const { generatePreferenceVector, generateEmbeddings } = await load({
      booksFromEmbeddings: false,
      weights: only('books'),
    });
    generateEmbeddings.mockResolvedValue([D]);

    const vector = await generatePreferenceVector(INPUT, [
      { id: 1, title: 'Albion', authors: ['Anna Hope'], embedding: A },
    ]);

    expect(generateEmbeddings).toHaveBeenCalledWith(['Books I have enjoyed: "Albion" by Anna Hope.']);
    expectDirection(vector, D);
  });
});
