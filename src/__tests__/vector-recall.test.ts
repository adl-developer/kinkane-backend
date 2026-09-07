import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every cosine-distance (`<=>`) query has to widen the HNSW search before it
 * runs.
 *
 * The index scan visits roughly `ef_search` graph nodes and stops; the WHERE
 * clause is applied to whatever it hands back, not pushed into it. At the
 * default of 40, a query asking for a pool of hundreds gets 40 rows offered to
 * a filter that rejects most of them — which is how the recommendations
 * endpoint came to return a single book. The LIMIT never enters into it.
 *
 * Nothing in the type system stops the next `<=>` query from being written
 * without the widening, so this asserts per query site rather than trusting one
 * shared helper.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/**
 * Every ANN query site in a source file, each paired with whether the scope it
 * sits in widens the search first.
 *
 * A site is an `.orderBy(...)` sorting by cosine distance — either written
 * inline as `<=>` or through a local bound to it (`distanceExpr`), which is how
 * recommendations.service.ts spells it. "Guarded" means a `SET LOCAL
 * hnsw.ef_search` appears between the start of the enclosing transaction
 * callback and the query itself.
 */
function annQuerySites(source: string): { line: number; guarded: boolean }[] {
  const sites: { line: number; guarded: boolean }[] = [];
  const orderBy = /\.orderBy\(([^)]*(?:\)[^)]*)*?)\)/g;

  for (const match of source.matchAll(orderBy)) {
    const argument = match[1];
    if (!/<=>|distanceExpr/.test(argument)) continue;

    // Walk back to the opening of the enclosing transaction callback; if there
    // is none, the scope is the whole preceding file, which cannot be guarded.
    const before = source.slice(0, match.index);
    const scopeStart = Math.max(
      before.lastIndexOf('db.transaction'),
      before.lastIndexOf('sql.begin'),
    );
    const scope = scopeStart === -1 ? '' : before.slice(scopeStart);

    sites.push({
      line: source.slice(0, match.index).split('\n').length,
      guarded: /SET LOCAL hnsw\.ef_search/.test(scope),
    });
  }
  return sites;
}

const SOURCES = {
  'books.service.ts': read('services/books.service.ts'),
  'recommendations.service.ts': read('services/recommendations.service.ts'),
};

describe('HNSW recall', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    describe(name, () => {
      it('sets ef_search for every cosine-distance query', () => {
        const sites = annQuerySites(source);
        expect(sites.length).toBeGreaterThan(0);

        // Each site is checked against its *own* enclosing scope. Counting
        // occurrences instead would pass on a file where one guarded query sits
        // beside an unguarded one — which is the regression this file exists
        // to catch, so the pairing has to be per site.
        const unguarded = sites.filter((site) => !site.guarded).map((site) => site.line);
        expect(unguarded).toEqual([]);
      });

      it('scopes the setting to a transaction, not the pooled connection', () => {
        // A bare `SET` would outlive the query and change the plan of whatever
        // unrelated request reuses that connection next.
        expect(source).not.toMatch(/SET hnsw\./);
      });
    });
  }

  it('runs the recommendation search inside a transaction that widens the scan', () => {
    const source = SOURCES['recommendations.service.ts'];
    const fetchRows = source.slice(source.indexOf('const fetchRows ='), source.indexOf('const withScoring ='));
    expect(fetchRows).toContain('db.transaction');
    expect(fetchRows).toContain('SET LOCAL hnsw.ef_search');
    expect(fetchRows).toContain('SET LOCAL hnsw.iterative_scan');
  });

  it('keeps rank exact — iterative scan must not reorder results', () => {
    // rank is the position in cosine order, so relaxed_order would mislabel it.
    expect(SOURCES['recommendations.service.ts']).toContain("HNSW_ITERATIVE_SCAN = 'strict_order'");
  });

  it('does not detect iterative-scan support with SHOW', () => {
    // pgvector registers its GUCs when its library first loads into a session,
    // which happens lazily on the first vector operation. On a freshly checked
    // out pooled connection `SHOW hnsw.iterative_scan` therefore raises
    // "unrecognized configuration parameter" even on 0.8.x — verified against
    // both the local and the hosted catalogue — so a probe built on it reports
    // "unsupported" on a server that supports it, and recall stays capped.
    // pg_extension answers correctly whenever it is asked.
    const source = SOURCES['recommendations.service.ts'];
    const probe = source.slice(
      source.indexOf('function supportsIterativeScan'),
      source.indexOf('function compareVersion'),
    );
    expect(probe).toContain('pg_extension');
    expect(probe).not.toMatch(/SHOW hnsw\./i);
  });

  it('the detector above actually fails on an unguarded query', () => {
    // A test that cannot fail is worse than no test, and the previous version of
    // this file could not: it counted occurrences and passed with any single
    // guarded site. This pins the detector itself against both shapes.
    const guarded = `
      db.transaction(async (tx) => {
        await tx.execute(sql.raw('SET LOCAL hnsw.ef_search = 100'));
        return tx.select().from(books).orderBy(sql\`embedding <=> vec\`).limit(10);
      });`;
    const unguarded = `
      db.transaction(async (tx) => {
        return tx.select().from(books).orderBy(sql\`embedding <=> vec\`).limit(10);
      });`;

    expect(annQuerySites(guarded).map((s) => s.guarded)).toEqual([true]);
    expect(annQuerySites(unguarded).map((s) => s.guarded)).toEqual([false]);
    // And a guarded site sitting next to an unguarded one is still a failure.
    expect(annQuerySites(guarded + unguarded).map((s) => s.guarded)).toEqual([true, false]);
  });

  it('retries a probe that failed rather than remembering its answer', () => {
    // The probe memoizes for the life of the process, so what it memoizes
    // matters: a version it actually read is determinate, but a query that
    // never reached the server is not. Caching the latter lets one blip — a
    // failover, or a saturated pool during the first request after deploy —
    // pin the process to the capped-recall path for good, silently
    // reinstating the single-book bug. The catch has to clear the slot.
    const source = SOURCES['recommendations.service.ts'];
    const probe = source.slice(
      source.indexOf('function supportsIterativeScan'),
      source.indexOf('async function probeIterativeScan'),
    );
    expect(probe).toMatch(/\.catch\([\s\S]*iterativeScanSupport = null/);
  });

  it('never asks the index for a far band on its own', () => {
    // The two tiers are cut out of one result set in memory. Expressing the
    // second as `distance >= SIMILARITY_THRESHOLD` reads naturally and is the
    // worst thing to ask an HNSW index: the scan walks outward from the nearest
    // neighbour, so that predicate rejects everything it visits first and the
    // iterative scan grinds through the whole reject zone before a single row
    // qualifies. Measured on an 83k-row catalogue, the sparse case cost 4524ms
    // across two passes against 7ms for the single pass.
    const source = SOURCES['recommendations.service.ts'];
    const search = source.slice(source.indexOf('async function fetchCandidateBooks'));
    expect(search).not.toMatch(/>=\s*\$\{SIMILARITY_THRESHOLD\}/);
  });

  it('reaches the catalogue once per search', () => {
    // One pass covering both tiers, not one per tier.
    const source = SOURCES['recommendations.service.ts'];
    const search = source.slice(source.indexOf('async function fetchCandidateBooks'));
    expect(search.match(/await fetchRows\(/g)?.length).toBe(1);
  });

  it('keeps the candidate pool small enough that an iterative scan stays cheap', () => {
    // Under iterative scan the LIMIT is what the scan works towards, so the pool
    // is paid for in latency rather than being free headroom. Measured on the
    // live catalogue: 300 rows ~800ms, 1000 rows 5-18s.
    const pool = SOURCES['recommendations.service.ts'].match(/const FETCH_POOL = (\d+);/);
    expect(pool).not.toBeNull();
    expect(Number(pool![1])).toBeLessThanOrEqual(500);
  });
});
