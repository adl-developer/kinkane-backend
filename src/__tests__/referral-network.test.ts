import { describe, it, expect } from 'vitest';
import { redactName, buildLongestChain, type NetworkNode } from '../services/referrals.service';
import { densify, weekBuckets } from '../services/referral-analytics.service';

/**
 * The journey map's two derived facts — how a referred reader is named, and
 * which path through the network is the longest — plus the chart densifier.
 *
 * All three are pure, and all three are the kind of thing that fails silently:
 * a redaction bug leaks a full name to a stranger, a chain bug draws a route
 * nobody took, and a missing week flattens a chart into a lie. None of them
 * throws when it goes wrong, so none of them is caught by anything but a test.
 */

const node = (over: Partial<NetworkNode> & Pick<NetworkNode, 'id' | 'referrerId' | 'degree'>): NetworkNode => ({
  name: 'X',
  city: null,
  countryCode: null,
  lat: null,
  lng: null,
  directReferrals: 0,
  signedUpAt: new Date('2026-01-01'),
  credited: true,
  ...over,
});

describe('redactName', () => {
  it('reduces a full name to first name and last initial', () => {
    expect(redactName('Amara Sowande')).toBe('Amara S.');
  });

  it('uses the LAST name for the initial, not the middle one', () => {
    // "Amara Nkechi Sowande" must not become "Amara N." — the initial is meant
    // to disambiguate between two Amaras, and a middle name is the part most
    // likely to be absent for one of them.
    expect(redactName('Amara Nkechi Sowande')).toBe('Amara S.');
  });

  it('leaves a single-word name alone rather than emitting a bare full stop', () => {
    expect(redactName('Kwame')).toBe('Kwame');
  });

  it('upper-cases the initial', () => {
    expect(redactName('amara sowande')).toBe('amara S.');
  });

  it('collapses runs of whitespace instead of reading them as name parts', () => {
    expect(redactName('  Amara   Sowande  ')).toBe('Amara S.');
  });

  it('falls back to a label rather than rendering an empty pin', () => {
    expect(redactName('   ')).toBe('A reader');
    expect(redactName('')).toBe('A reader');
  });

  it('never returns a name with more than one surname character', () => {
    // The guarantee the whole redaction rests on: whatever goes in, at most one
    // character of the surname comes out.
    for (const name of ['Amara Sowande', 'Chen Wei Zhang', 'Priya Ramachandran']) {
      const surname = redactName(name).split(' ')[1] ?? '';
      expect(surname.replace('.', '')).toHaveLength(1);
    }
  });
});

describe('degree numbering after a void', () => {
  // networkFor now takes the caller's own depth from their referral row rather
  // than inferring it from the shallowest surviving descendant. This exercises
  // the arithmetic that depended on it, because the inference was wrong in
  // exactly one case and that case is invisible until an admin voids something.
  const degreesFor = (base: number, depths: number[]) => depths.map((d) => d - base);

  it('keeps grandchildren at second degree when the parent is voided', () => {
    // A (root, depth 0) -> B (depth 1) -> C (depth 2). A->B is voided, so only
    // C survives the status filter and the shallowest remaining row is depth 2.
    const survivingDepths = [2];

    // The old inference: min(depth) - 1 = 1, making C look like a direct referral.
    const inferred = degreesFor(Math.min(...survivingDepths) - 1, survivingDepths);
    expect(inferred).toEqual([1]);

    // The caller's real depth is 0, which keeps C where it belongs.
    expect(degreesFor(0, survivingDepths)).toEqual([2]);
  });

  it('is unchanged for a caller partway down another tree', () => {
    // A caller at depth 4 with children at 5 and grandchildren at 6.
    expect(degreesFor(4, [5, 5, 6])).toEqual([1, 1, 2]);
  });
});

describe('buildLongestChain', () => {
  const ROOT = 100;

  it('is empty for a user who has referred nobody', () => {
    expect(buildLongestChain(ROOT, [])).toEqual({ links: 0, hops: [] });
  });

  it('walks a single chain from the caller down to the deepest node', () => {
    const nodes = [
      node({ id: 1, referrerId: ROOT, degree: 1, name: 'Amara S.', city: 'Paris' }),
      node({ id: 2, referrerId: 1, degree: 2, name: 'Priya R.', city: 'Calcutta' }),
      node({ id: 3, referrerId: 2, degree: 3, name: 'Chen W.', city: 'Hong Kong' }),
      node({ id: 4, referrerId: 3, degree: 4, name: 'Lin C.', city: 'Singapore' }),
    ];

    const chain = buildLongestChain(ROOT, nodes);

    expect(chain.hops.map((h) => h.city)).toEqual(['Paris', 'Calcutta', 'Hong Kong', 'Singapore']);
    // Four names, four links — the caller is the fifth point on the strip and
    // is deliberately not in `nodes`.
    expect(chain.links).toBe(4);
  });

  it('picks the deepest branch, not the widest or the first', () => {
    const nodes = [
      node({ id: 1, referrerId: ROOT, degree: 1, city: 'Lagos' }),
      node({ id: 2, referrerId: ROOT, degree: 1, city: 'London' }),
      node({ id: 3, referrerId: ROOT, degree: 1, city: 'Madrid' }),
      // The only branch that goes deeper.
      node({ id: 4, referrerId: 2, degree: 2, city: 'New York' }),
      node({ id: 5, referrerId: 4, degree: 3, city: 'Chicago' }),
    ];

    expect(buildLongestChain(ROOT, nodes).hops.map((h) => h.city)).toEqual(['London', 'New York', 'Chicago']);
  });

  it('breaks a tie between equally deep branches by earliest signup, so the strip is stable', () => {
    const nodes = [
      node({ id: 1, referrerId: ROOT, degree: 1, city: 'Accra' }),
      node({ id: 2, referrerId: ROOT, degree: 1, city: 'Cairo' }),
      node({ id: 3, referrerId: 1, degree: 2, city: 'Tokyo', signedUpAt: new Date('2026-03-01') }),
      node({ id: 4, referrerId: 2, degree: 2, city: 'Dubai', signedUpAt: new Date('2026-02-01') }),
    ];

    // Dubai joined first, so Dubai's branch wins — and keeps winning on every
    // subsequent call, which is the point.
    expect(buildLongestChain(ROOT, nodes).hops.map((h) => h.city)).toEqual(['Cairo', 'Dubai']);
    expect(buildLongestChain(ROOT, nodes)).toEqual(buildLongestChain(ROOT, nodes));
  });

  it('stops at the caller rather than walking past them', () => {
    const nodes = [node({ id: 1, referrerId: ROOT, degree: 1, city: 'Accra' })];
    const chain = buildLongestChain(ROOT, nodes);

    expect(chain.links).toBe(1);
    expect(chain.hops).toHaveLength(1);
  });

  it('terminates on a broken parent link instead of looping forever', () => {
    // A node whose referrer is neither the caller nor present in the set — only
    // reachable if a subtree is ever trimmed, but an infinite loop here would
    // hang the request rather than return a wrong answer.
    const nodes = [node({ id: 9, referrerId: 777, degree: 3, city: 'Beirut' })];

    expect(buildLongestChain(ROOT, nodes).hops.map((h) => h.city)).toEqual(['Beirut']);
  });
});

describe('weekBuckets', () => {
  // A Wednesday, so every case also exercises the snap back to Monday.
  const start = new Date('2026-08-05T09:30:00Z');

  it('numbers weeks from the campaign start, not from the chart', () => {
    const weeks = weekBuckets(start, new Date('2026-09-02T00:00:00Z'));

    expect(weeks.map((w) => w.weekNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(weeks[0].weekStart).toBe('2026-08-03');
    expect(weeks[0].weekEnd).toBe('2026-08-09');
  });

  it('grows by one bucket a week while keeping week 1 in place', () => {
    const early = weekBuckets(start, new Date('2026-09-02T00:00:00Z'));
    const later = weekBuckets(start, new Date('2026-11-04T00:00:00Z'));

    expect(later.length).toBeGreaterThan(early.length);
    expect(later[0]).toEqual(early[0]);
  });

  it('covers the week in progress rather than stopping at the last complete one', () => {
    const weeks = weekBuckets(start, new Date('2026-08-06T00:00:00Z'));
    expect(weeks).toHaveLength(1);
  });

  it('still emits a week when the campaign has not started yet', () => {
    // Otherwise the charts would render with no axis at all.
    const weeks = weekBuckets(new Date('2099-01-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
    expect(weeks).toHaveLength(1);
  });
});

describe('densify', () => {
  const buckets = weekBuckets(new Date('2026-08-03T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));

  it('emits every week in the window even when nothing happened', () => {
    expect(densify([], buckets)).toEqual([0, 0, 0, 0, 0]);
  });

  it('places a bucket on the week it belongs to', () => {
    const filled = densify([{ week: buckets[3].weekStart, n: 42 }], buckets);

    // And only that week — a misaligned bucket would smear the count.
    expect(filled).toEqual([0, 0, 0, 42, 0]);
  });

  it('ignores rows outside the window rather than shifting them into it', () => {
    expect(densify([{ week: '2020-01-06', n: 99 }], buckets)).toEqual([0, 0, 0, 0, 0]);
  });
});
