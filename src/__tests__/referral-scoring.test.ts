import { describe, it, expect } from 'vitest';
import {
  scoreDirectReferral,
  findCircuitEarners,
  POINTS,
  type PathNode,
} from '../services/referral-scoring.service';
import type { Continent } from '../db/schema';

// The competition's rules live in two pure functions, and everything expensive
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

describe('findCircuitEarners', () => {
  it('awards the ancestor whose chain left the continent and came back', () => {
    // Tom(AF) → Ama(EU) → Lisa(AF): Tom's referrals went abroad and returned.
    const path = [at('AF', 1), at('EU', 2)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1]);
  });

  it('awards nobody when the chain never left', () => {
    const path = [at('AF', 1), at('AF', 2)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('awards nobody when the chain left but did not return', () => {
    // Tom(AF) → Jen(AS) → Alexander(AS). Left Africa, still away.
    const path = [at('AF', 1), at('AS', 2)];
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
    // Two people on AF sit above a European excursion that returns to AF; both
    // have had their referrals go around the world.
    const path = [at('AF', 1), at('AF', 2), at('EU', 3)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1, 2]);
  });

  it('does not award an ancestor sitting after the last departure', () => {
    // Ancestor 3 is on AF, but everything between it and the redeemer is also
    // on AF — nothing left the continent below it, so it has no circuit even
    // though an ancestor above it does.
    const path = [at('AF', 1), at('EU', 2), at('AF', 3)];
    expect(findCircuitEarners(path, 'AF')).toEqual([1]);
  });

  it('does not let an unknown continent stand in for leaving', () => {
    // An ancestor whose country never resolved must not manufacture a circuit
    // that a known one wouldn't — otherwise a failed geo lookup becomes worth
    // 30 points.
    const path = [at('AF', 1), at(null, 2)];
    expect(findCircuitEarners(path, 'AF')).toEqual([]);
  });

  it('awards nothing when the redeemer has no continent', () => {
    const path = [at('AF', 1), at('EU', 2)];
    expect(findCircuitEarners(path, null)).toEqual([]);
  });

  it('handles a direct referral with no intermediates', () => {
    // A one-element path can never be a circuit: there is nothing between the
    // referrer and the redeemer to have left the continent.
    expect(findCircuitEarners([at('AF', 1)], 'AF')).toEqual([]);
    expect(findCircuitEarners([at('AF', 1)], 'EU')).toEqual([]);
  });

  it('never awards the same ancestor twice within one detection', () => {
    // The ledger's partial unique index is the real guard, but the function
    // should not be handing it duplicates to swallow.
    const path = [at('AF', 1), at('EU', 2), at('AF', 1)];
    const earners = findCircuitEarners(path, 'AF');
    expect(new Set(earners).size).toBe(earners.length);
  });
});
