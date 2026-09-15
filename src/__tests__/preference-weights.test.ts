import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeVector, combineWeightedVectors, type WeightedLane } from '../lib/vector';

/**
 * The weighting maths, tested without Gemini or the database.
 *
 * These pin the properties the env weights are sold on: 0 means gone, the
 * numbers are ratios rather than shares, and a dislike pushes away instead of
 * pulling towards.
 */

const lane = (
  field: string,
  vector: number[],
  weight: number,
  sign: 1 | -1 = 1,
): WeightedLane => ({ field, vector, weight, sign });

// Two orthogonal directions, so "which way did the result lean" is readable
// straight off the components.
const X = [1, 0, 0];
const Y = [0, 1, 0];

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((acc, n) => acc + n * n, 0));
}

describe('normalizeVector', () => {
  it('scales to unit length', () => {
    const unit = normalizeVector([3, 4, 0]);
    expect(unit).not.toBeNull();
    expect(magnitude(unit!)).toBeCloseTo(1, 10);
    expect(unit![0]).toBeCloseTo(0.6, 10);
  });

  it('strips magnitude, so a longer clause does not weigh more', () => {
    // The whole point of normalising: [1,0,0] and [50,0,0] are the same
    // direction, and a field that produced a bigger vector must not therefore
    // count for more.
    expect(normalizeVector([1, 0, 0])).toEqual(normalizeVector([50, 0, 0]));
  });

  it('returns null rather than dividing by zero', () => {
    expect(normalizeVector([0, 0, 0])).toBeNull();
    expect(normalizeVector([])).toBeNull();
    expect(normalizeVector([1, NaN, 0])).toBeNull();
  });
});

describe('combineWeightedVectors', () => {
  it('drops a lane weighted 0 entirely', () => {
    const withZero = combineWeightedVectors([lane('a', X, 100), lane('b', Y, 0)]);
    const withoutLane = combineWeightedVectors([lane('a', X, 100)]);
    expect(withZero).toEqual(withoutLane);
  });

  it('treats weights as ratios, not shares of a budget', () => {
    // Every weight at 50 must behave identically to every weight at 100 —
    // cosine distance ignores magnitude and the sum is normalised, so only the
    // relationship between lanes can matter.
    const atFifty = combineWeightedVectors([lane('a', X, 50), lane('b', Y, 50)]);
    const atHundred = combineWeightedVectors([lane('a', X, 100), lane('b', Y, 100)]);
    expect(atFifty!.map((n) => +n.toFixed(10))).toEqual(atHundred!.map((n) => +n.toFixed(10)));
  });

  it('leans towards the heavier lane', () => {
    const combined = combineWeightedVectors([lane('heavy', X, 100), lane('light', Y, 25)])!;
    expect(combined[0]).toBeGreaterThan(combined[1]);

    // And the lean tracks the ratio: 100:25 should sit closer to X than 100:75.
    const lessLopsided = combineWeightedVectors([lane('heavy', X, 100), lane('light', Y, 75)])!;
    expect(combined[0]).toBeGreaterThan(lessLopsided[0]);
  });

  it('pushes away from a negative lane instead of towards it', () => {
    const withoutDislike = combineWeightedVectors([lane('books', X, 100)])!;
    const withDislike = combineWeightedVectors([
      lane('books', X, 100),
      lane('dislikes', Y, 50, -1),
    ])!;

    // The dislike direction must come out negative — this is the behaviour the
    // old concatenated text got backwards, where "I want to avoid gore" landed
    // near gore.
    expect(withDislike[1]).toBeLessThan(0);
    expect(withoutDislike[1]).toBeCloseTo(0, 10);
  });

  it('always returns a unit vector', () => {
    const combined = combineWeightedVectors([
      lane('a', [2, 0, 0], 100),
      lane('b', [0, 7, 0], 30),
      lane('c', [0, 0, 5], 60, -1),
    ])!;
    expect(magnitude(combined)).toBeCloseTo(1, 10);
  });

  it('returns null when every lane is disabled', () => {
    expect(combineWeightedVectors([lane('a', X, 0), lane('b', Y, 0)])).toBeNull();
    expect(combineWeightedVectors([])).toBeNull();
  });

  it('returns null when lanes cancel out', () => {
    // A dislike exactly opposing an equally weighted like leaves no direction
    // to search in. The caller falls back rather than querying on noise.
    expect(
      combineWeightedVectors([lane('books', X, 100), lane('dislikes', X, 100, -1)]),
    ).toBeNull();
  });

  it('refuses to mix embedding dimensions', () => {
    expect(() =>
      combineWeightedVectors([lane('a', [1, 0, 0], 100), lane('b', [0, 1], 100)]),
    ).toThrow(/dimensions/);
  });
});

/**
 * Weighting ships dark. An environment that sets none of the RECO_* variables
 * must behave exactly as the pipeline did before any of this existed — same
 * vector, same cache keys, same results. These read the source rather than
 * booting the config, so they hold regardless of what is in the ambient
 * environment when the suite runs.
 */
describe('shipping dark', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
  const configSource = read('config/index.ts');
  const serviceSource = read('services/recommendations.service.ts');

  it('defaults the master switch to off', () => {
    const declaration = configSource.slice(
      configSource.indexOf('RECO_WEIGHTING_ENABLED:'),
      configSource.indexOf('RECO_WEIGHT_GENRES:'),
    );
    expect(declaration).toContain("default('false')");
  });

  it('falls back to the single combined-paragraph embedding when switched off', () => {
    const fn = serviceSource.slice(
      serviceSource.indexOf('export async function generatePreferenceVector('),
    );
    const guard = fn.slice(0, fn.indexOf('const lanes = buildPreferenceLanes'));
    expect(guard).toContain('!config.recommendations.weightingEnabled');
    expect(guard).toContain('generateEmbedding(buildPreferenceText(input, likedBooks))');
  });

  it('leaves the cache key untouched for an environment that changed nothing', () => {
    // A fingerprint of the defaults would still be a new key, flushing 48 hours
    // of entries on deploy for results that are identical. Returning undefined
    // keeps the key byte-identical, because JSON.stringify drops the field.
    const fn = serviceSource.slice(
      serviceSource.indexOf('function retrievalFingerprint('),
      serviceSource.indexOf('export async function generatePreferenceVector('),
    );
    expect(fn).toContain('): string | undefined');
    expect(fn).toContain('if (isBaseline) return undefined;');
    expect(fn).toContain('!weightingEnabled');
  });

  it('pins the baseline constants to the values that shipped before weighting', () => {
    expect(serviceSource).toContain('const BASELINE_SIMILARITY_MAX = 0.5;');
    expect(serviceSource).toContain('const BASELINE_BACKFILL_MAX = 0.7;');
    expect(serviceSource).toContain('const BASELINE_TARGET_RESULTS = 100;');
  });
});
