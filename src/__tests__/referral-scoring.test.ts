import { describe, it, expect } from 'vitest';
import {
  scoreDirectReferral,
  scoreIndirectReferral,
  findCircuitEarners,
  POINTS,
  CIRCUIT_CONTINENTS_REQUIRED,
  type PathNode,
} from '../services/referral-scoring.service';
import type { Continent } from '../db/schema';

// The competition's rules live in three pure functions, and everything expensive
// about getting them wrong is invisible from the outside: a wrong continent
// boundary quietly pays 10 instead of 20, and a wrong circuit predicate either
// never fires or fires for everyone. These cover the cases that decide points,
// with the awkward ones — unknown geography, a circuit closing many levels down
// — written as arrays rather than database fixtures.

const at = (continent: Continent | null, userId = 0): PathNode => ({ userId, continent });

describe('scoreDirectReferral', () => {
  it('pays 1 for the same country', () => {
    expect(scoreDirectReferral({ country: 'GH', continent: 'AF' }, { country: 'GH', continent: 'AF' })).toEqual({
      kind: 'same_country',
      points: 1,
    });
  });

  it('pays 10 across countries on one continent', () => {
    expect(scoreDirectReferral({ country: 'GH', continent: 'AF' }, { country: 'NG', continent: 'AF' })).toEqual({
      kind: 'same_continent',
      points: 10,
    });
  });

  it('pays 20 across continents', () => {
    expect(scoreDirectReferral({ country: 'GH', continent: 'AF' }, { country: 'GB', continent: 'EU' })).toEqual({
      kind: 'cross_continent',
      points: 20,
    });
  });

  it('pays nothing when either side has no continent', () => {
    // Unknown geography must never be worth points in either direction —
    // otherwise an unresolvable IP becomes a way to farm the highest award.
    expect(scoreDirectReferral({ country: null, continent: null }, { country: 'GB', continent: 'EU' })).toBeNull();
    expect(scoreDirectReferral({ country: 'GH', continent: 'AF' }, { country: null, continent: null })).toBeNull();
  });

  it('pays nothing for an identical but unplaceable country', () => {
    // Both in AQ, or both in a code the seed predates. Paying the same-country
    // point here would make an unresolvable country marginally profitable to
    // have, which is the wrong incentive to build into a leaderboard.
    expect(scoreDirectReferral({ country: 'AQ', continent: null }, { country: 'AQ', continent: null })).toBeNull();
  });

  it('never pays more than the cross-continent award for a single referral', () => {
    // Guards the ordering of the branches: a change that let same_country fall
    // through to cross_continent would inflate every domestic referral 20x.
    const combos: [string, Continent][] = [
      ['GH', 'AF'], ['NG', 'AF'], ['GB', 'EU'], ['JP', 'AS'], ['BR', 'SA'], ['AU', 'OC'], ['US', 'NA'],
    ];
    for (const [c1, k1] of combos) {
      for (const [c2, k2] of combos) {
        const award = scoreDirectReferral({ country: c1, continent: k1 }, { country: c2, continent: k2 });
        expect(award!.points).toBeLessThanOrEqual(POINTS.cross_continent);
      }
    }
  });
});

describe('scoreIndirectReferral', () => {
  // Tom → Ama → Lisa. These are Tom's points for Lisa, and the comparison is
  // always Lisa against *Tom*, never against Ama.

  it('pays 5 for another country on the earner’s continent', () => {
    expect(scoreIndirectReferral({ country: 'GH', continent: 'AF' }, { country: 'NG', continent: 'AF' })).toEqual({
      kind: 'indirect_same_continent',
      points: 5,
    });
  });

  it('pays 10 for another continent', () => {
    expect(scoreIndirectReferral({ country: 'GH', continent: 'AF' }, { country: 'JP', continent: 'AS' })).toEqual({
      kind: 'indirect_cross_continent',
      points: 10,
    });
  });

  it('pays nothing in the earner’s own country', () => {
    // The rules list 5 and 10 and stop. The second degree pays for spread only —
    // this is what stops a purely domestic tree paying its root forever.
    expect(scoreIndirectReferral({ country: 'GH', continent: 'AF' }, { country: 'GH', continent: 'AF' })).toBeNull();
  });

  it('is measured against the earner, not the middle person', () => {
    // Tom(GH) → Ama(GB) → Lisa(FR). Compared to Ama, Lisa is same-continent;
    // compared to Tom she is a different continent entirely. Tom earns the
    // cross-continent 10, because the points describe how far *his* network
    // reached.
    expect(scoreIndirectReferral({ country: 'GH', continent: 'AF' }, { country: 'FR', continent: 'EU' })).toEqual({
      kind: 'indirect_cross_continent',
      points: 10,
    });
  });

  it('never pays more than the equivalent direct award', () => {
    // The second degree must always be worth less than referring someone
    // yourself, or the incentive inverts.
    const combos: [string, Continent][] = [['GH', 'AF'], ['NG', 'AF'], ['GB', 'EU'], ['JP', 'AS']];
    for (const [c1, k1] of combos) {
      for (const [c2, k2] of combos) {
        const earner = { country: c1, continent: k1 };
        const redeemer = { country: c2, continent: k2 };
        const indirect = scoreIndirectReferral(earner, redeemer);
        const direct = scoreDirectReferral(earner, redeemer);
        if (indirect) expect(indirect.points).toBeLessThan(direct!.points);
      }
    }
  });

  it('pays nothing when either side has no continent', () => {
    expect(scoreIndirectReferral({ country: null, continent: null }, { country: 'GB', continent: 'EU' })).toBeNull();
    expect(scoreIndirectReferral({ country: 'GH', continent: 'AF' }, { country: null, continent: null })).toBeNull();
  });
});

describe('findCircuitEarners', () => {
  it('awards an ancestor whose chain crossed two continents and returned', () => {
    // Tom(AF) → Ama(EU) → Ken(AS) → Lisa(AF): two foreign continents, home again.
    const path = [at('AF', 1), at('EU', 2), at('AS', 3)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1]);
  });

  it('does NOT award a chain that only reached one foreign continent', () => {
    // The rule that changed. Under the previous one-continent bar this scored;
    // now a single hop abroad and back is not a journey around the world.
    const path = [at('AF', 1), at('EU', 2)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('counts continents distinctly, not as visits', () => {
    // Four European stops are still one foreign continent. Otherwise a circuit
    // could be farmed by bouncing between two neighbouring countries.
    const path = [at('AF', 1), at('EU', 2), at('EU', 3), at('EU', 4), at('EU', 5)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('awards nobody when the chain never left', () => {
    const path = [at('AF', 1), at('AF', 2)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('awards nobody when the chain left twice over but did not return', () => {
    // Tom(AF) → Ama(EU) → Ken(AS) → redeemer also in Asia. Two continents
    // touched, but the journey never came home.
    const path = [at('AF', 1), at('EU', 2), at('AS', 3)];
    expect(findCircuitEarners(path, 'AS')).toEqual([]);
  });

  it('fires retroactively when a deep descendant closes the loop', () => {
    // The circuit arrives from someone the referrer has never met, several
    // levels down and possibly months later — the asynchrony is the feature,
    // and this is the case that proves the walk goes all the way up.
    const path = [at('AF', 1), at('AS', 2), at('AS', 3), at('EU', 4), at('EU', 5)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1]);
  });

  it('awards every ancestor who qualifies, not just the root', () => {
    const path = [at('AF', 1), at('AF', 2), at('EU', 3), at('SA', 4)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1, 2]);
  });

  it('does not award an ancestor sitting below the travelling section', () => {
    // Ancestor 4 is on AF, but everything below it is also AF — nothing left the
    // continent beneath it, so it has no circuit even though ancestors above do.
    const path = [at('AF', 1), at('EU', 2), at('AS', 3), at('AF', 4)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1]);
  });

  it('does not let unknown continents stand in for foreign ones', () => {
    // Two unresolvable ancestors must not add up to a journey — otherwise a
    // pair of failed geo lookups is worth 30 points.
    const path = [at('AF', 1), at(null, 2), at(null, 3)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('does not count an unknown continent towards the two required', () => {
    // One real foreign continent plus one unknown is still one.
    const path = [at('AF', 1), at('EU', 2), at(null, 3)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('awards nothing when the redeemer has no continent', () => {
    const path = [at('AF', 1), at('EU', 2), at('AS', 3)];
    expect(findCircuitEarners(path, null)).toEqual([]);
  });

  it('cannot be satisfied by a path shorter than the requirement', () => {
    // A direct referral has nothing between referrer and redeemer at all, so no
    // number of continents can appear.
    expect(findCircuitEarners([at('AF', 1)], 'AF')).toEqual([]);
    expect(findCircuitEarners([at('AF', 1)], 'EU')).toEqual([]);
  });

  it('needs exactly CIRCUIT_CONTINENTS_REQUIRED distinct foreign continents', () => {
    // Pins the boundary to the constant rather than to the number 2, so a
    // deliberate rule change moves the threshold and an accidental one fails.
    const foreign: Continent[] = ['EU', 'AS', 'SA', 'NA', 'OC'];
    for (let n = 0; n <= foreign.length; n++) {
      const path = [at('AF', 1), ...foreign.slice(0, n).map((c, i) => at(c, i + 2))];
      const earners = findCircuitEarners(path, 'AF');
      expect(earners.length).toBe(n >= CIRCUIT_CONTINENTS_REQUIRED ? 1 : 0);
    }
  });

  it('never awards the same ancestor twice within one detection', () => {
    // The ledger's partial unique index is the real guard, but the function
    // should not be handing it duplicates to swallow.
    const path = [at('AF', 1), at('EU', 2), at('AS', 3), at('AF', 1)];
    const earners = findCircuitEarners(path, 'AF');
    expect(new Set(earners).size).toBe(earners.length);
  });
});
