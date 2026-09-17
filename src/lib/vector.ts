/**
 * Vector maths for the weighted preference embedding.
 *
 * Kept free of Gemini and the database on purpose: everything here is pure, so
 * the weighting behaviour can be tested without a network call or a fixture.
 */

/**
 * Scales a vector to unit length.
 *
 * This is what makes per-field weights comparable at all. Embedding one clause
 * of five book titles and another of two genre words produces vectors of
 * different magnitude, and combining them raw would weight them by how much
 * text each field happened to contribute — which is exactly the accidental
 * weighting the lanes exist to replace. Normalising first strips magnitude out
 * and leaves only direction, so a weight of 50 means the same thing to every
 * field.
 *
 * Returns null for a zero or non-finite vector rather than dividing by zero.
 */
export function normalizeVector(vector: number[]): number[] | null {
  if (vector.length === 0) return null;

  let sumOfSquares = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return null;
    sumOfSquares += value * value;
  }

  const magnitude = Math.sqrt(sumOfSquares);
  // Not `=== 0`: a vector this short is numerically indistinguishable from the
  // origin, and dividing by it produces garbage rather than a direction.
  if (!(magnitude > 1e-12)) return null;

  return vector.map((value) => value / magnitude);
}

export interface WeightedLane {
  /** Which preference field this lane carries — used only for logging. */
  field: string;
  /** The field's embedding, in the same space as the book vectors. */
  vector: number[];
  /**
   * 0-100, straight from the environment. Relative, not a share of a budget:
   * every weight at 50 is identical to every weight at 100, because the
   * combined vector is normalised at the end and cosine distance ignores
   * magnitude. What matters is the ratio between lanes.
   */
  weight: number;
  /**
   * +1 pulls the query towards this lane, -1 pushes away from it.
   *
   * The negative case is what makes `dislikes` work. As part of the old
   * single-paragraph text it read as "I want to avoid: gore" — and an
   * embedding has no notion of negation, so that phrase lands near *gore* and
   * the stated dislike pulled results towards the thing being rejected.
   * Subtracting the lane expresses "away from this" the way the vector space
   * actually represents direction.
   */
  sign: 1 | -1;
}

/**
 * Combines per-field embeddings into a single query vector:
 *
 *     v = normalize( Σ sign_i · (weight_i / 100) · normalize(v_i) )
 *
 * Lanes at weight 0 contribute nothing. Lanes whose vector cannot be
 * normalised are skipped rather than poisoning the sum.
 *
 * Returns null when there is nothing usable to combine — every lane skipped,
 * or the survivors cancelling each other out to approximately the origin
 * (possible when a heavily-weighted dislike opposes a similar liked-books
 * lane). Both cases mean "this weighting produced no usable direction", and
 * the caller is expected to fall back rather than search on noise.
 */
export function combineWeightedVectors(lanes: WeightedLane[]): number[] | null {
  const usable: { unit: number[]; coefficient: number }[] = [];
  let dimensions = 0;

  for (const lane of lanes) {
    if (lane.weight <= 0) continue;

    const unit = normalizeVector(lane.vector);
    if (!unit) continue;

    if (dimensions === 0) {
      dimensions = unit.length;
    } else if (unit.length !== dimensions) {
      // Two different embedding models, or a truncated response. Mixing them
      // would produce a vector that is meaningless in both spaces.
      throw new Error(
        `Preference lane "${lane.field}" has ${unit.length} dimensions, expected ${dimensions}`,
      );
    }

    usable.push({ unit, coefficient: lane.sign * (lane.weight / 100) });
  }

  if (usable.length === 0) return null;

  const sum = new Array<number>(dimensions).fill(0);
  for (const { unit, coefficient } of usable) {
    for (let i = 0; i < dimensions; i++) {
      sum[i] += unit[i] * coefficient;
    }
  }

  return normalizeVector(sum);
}

/**
 * Averages several book embeddings into one direction — the centroid of a
 * reader's "Just Right" books.
 *
 * Each vector is normalised before it is added, for the same reason lanes are:
 * a book with a long blurb produces a longer vector than one with a two-line
 * description, and averaging raw would let the wordier book speak for the
 * reader's taste. Every book gets one equal vote.
 *
 * Returns null when nothing usable was passed, or when the books point in
 * directions that cancel out. The caller falls back rather than searching on
 * whatever is left near the origin.
 *
 * Note the known limit of a centroid: a reader whose books are genuinely two
 * different tastes (literary fiction and cosy crime) averages to a point that
 * is neither, and the nearest books to it may resemble nothing they named.
 * Splitting multi-modal taste into more than one query is a separate change;
 * this function deliberately does the simple thing.
 */
export function averageUnitVectors(vectors: number[][]): number[] | null {
  const units: number[][] = [];
  let dimensions = 0;

  for (const vector of vectors) {
    const unit = normalizeVector(vector);
    if (!unit) continue;

    if (dimensions === 0) {
      dimensions = unit.length;
    } else if (unit.length !== dimensions) {
      throw new Error(
        `Cannot average vectors of ${unit.length} and ${dimensions} dimensions`,
      );
    }

    units.push(unit);
  }

  if (units.length === 0) return null;

  const sum = new Array<number>(dimensions).fill(0);
  for (const unit of units) {
    for (let i = 0; i < dimensions; i++) {
      sum[i] += unit[i];
    }
  }

  // Normalised rather than divided by the count: the caller only needs the
  // direction, and dividing would leave a vector whose length encodes how much
  // the books agreed with each other — which nothing downstream reads.
  return normalizeVector(sum);
}
