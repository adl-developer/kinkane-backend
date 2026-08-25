import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildAuthorMatchCondition, buildAuthorMatchSource } from '../services/books.service';

// Search matches a book by its author's name as well as by its title. The risk in that
// feature is never correctness of the match — it's cost: book_contributors is the larger
// table, and an author query that isn't bounded, or that has to be re-evaluated per
// candidate row, is what turned earlier versions of book search into multi-second
// queries. These cover the properties that keep it cheap, since none of them are visible
// from the returned rows and all of them are easy to undo by accident.

const dialect = new PgDialect();

function compile(q: string, tier: 'cheap' | 'broad'): string {
  return dialect.sqlToQuery(buildAuthorMatchCondition(q, tier)).sql;
}

describe('buildAuthorMatchCondition', () => {
  it('caps every branch, not just the merged result', () => {
    // A single cap on the outer result is not enough: an uncapped branch still has to
    // produce its whole match set before the merge can discard it, so cost would scale
    // with how common the name fragment is — one cap per branch. Asserted as a ratio
    // rather than a fixed count, so adding a tier can't quietly leave it uncapped.
    for (const tier of ['cheap', 'broad'] as const) {
      const sql = compile('king', tier);
      const branches = sql.match(/select\s+bc\.book_id/gi)?.length ?? 0;
      const limits = sql.match(/limit \$\d+/gi)?.length ?? 0;
      expect(branches, `${tier}: no branches found`).toBeGreaterThan(0);
      expect(limits, `${tier}: ${branches} branches but ${limits} caps`).toBe(branches);
    }
  });

  it('never sorts on a computed expression', () => {
    // ORDER BY over a CASE (or any expression an index can't provide) forces Postgres to
    // consume the entire match set before applying a LIMIT — ranking must come from the
    // branch tag, which is a constant within each branch.
    expect(compile('king', 'broad')).not.toMatch(/order by/i);
  });

  it('exposes the prefix tier as a WHERE the pattern index can range-scan', () => {
    // Plain LIKE against lower(person_name): text_pattern_ops matches no other operator,
    // and it has to be in the WHERE — an index can serve a predicate, not an ORDER BY
    // over an expression.
    expect(compile('king', 'cheap')).toMatch(
      /where[\s\S]*lower\(bc\.person_name\) like lower\(\$\d+\)/i,
    );
  });

  it('is uncorrelated — the subquery never references the outer books row', () => {
    // A reference to books.id inside the subquery would make Postgres re-run it per
    // candidate row, which is what the previous MIN(CASE ...) ranking did.
    const sql = compile('king', 'cheap');
    const subquery = sql.slice(sql.indexOf('IN ('));
    expect(subquery).not.toMatch(/books\.\s*"?id"?/i);
  });

  it('ranks primary authors above other contributors, rather than filtering to them', () => {
    // This used to filter to A01 outright, on the reasoning that a book's editors,
    // translators and illustrators are not what someone typing a name is looking for.
    // That is right as a ranking rule and wrong as a filter: about one book in five has
    // no A01 contributor at all, and those were unreachable by name at any spelling.
    //
    // So both predicates must be present, and the A01 arms must carry the lower (better)
    // tier tag. A01 stays a fixed literal rather than a bound parameter so it reads as
    // part of the query's shape.
    const sql = compile('king', 'cheap');
    expect(sql).toMatch(/bc\.role = 'A01'/);
    expect(sql).toMatch(/bc\.role <> 'A01'/);

    const tierOf = (rolePredicate: RegExp) => {
      const at = sql.search(rolePredicate);
      // The tier tag is emitted ahead of its branch's WHERE clause.
      const tags = [...sql.slice(0, at).matchAll(/(\d+) AS tier/gi)];
      return Number(tags[tags.length - 1][1]);
    };
    expect(tierOf(/bc\.role = 'A01'/)).toBeLessThan(tierOf(/bc\.role <> 'A01'/));
  });

  it('ranks an exact match on any role above a fuzzy match on an author', () => {
    // The ladder's load-bearing property, and the reason role is the inner sort key
    // rather than the outer one. Someone typing "Catherine Eschle" wants the volume she
    // edited — an exact prefix hit — not a fuzzy slide to "Catherine Dawson".
    const sql = compile('king', 'broad');
    const fuzzyAt = sql.search(/<%/);
    const otherRoleAt = sql.search(/bc\.role <> 'A01'/);
    expect(fuzzyAt, 'the broad tier emitted no fuzzy arm').toBeGreaterThanOrEqual(0);
    expect(otherRoleAt).toBeLessThan(fuzzyAt);
  });

  it('keeps the fuzzy tiers out of the cheap condition', () => {
    // <% and the FTS fallback are the expensive part; the cheap tier is reached on
    // every ordinary search, so they must only appear once the caller escalates.
    const cheap = compile('king', 'cheap');
    expect(cheap).not.toContain('<%');
    expect(cheap).not.toContain('to_tsvector');

    const broad = compile('king', 'broad');
    expect(broad).toContain('<%');
    expect(broad).toContain('to_tsvector');
  });

  it('drops the FTS arm for fragments too short to tokenise usefully', () => {
    // Mirrors buildSearchCondition's own >= 3 rule: a one- or two-character query
    // produces a tsquery that matches almost nothing useful but still costs a scan.
    expect(compile('ki', 'broad')).not.toContain('to_tsvector');
    expect(compile('kin', 'broad')).toContain('to_tsvector');
  });

  it('parameterises the query rather than interpolating it', () => {
    const { sql, params } = dialect.sqlToQuery(buildAuthorMatchCondition("o'brien", 'broad'));
    expect(sql).not.toContain("o'brien");
    expect(params).toContain("o'brien%");
  });
});

describe('buildAuthorMatchSource', () => {
  it('tags each branch with a constant tier the caller can rank on', () => {
    // The tier is what makes an exact name match outrank a fuzzy one. It has to be a
    // constant per branch so that ordering by it never costs a per-row computation —
    // and it has to be carried out of the subquery, not discarded, or the author branch
    // ends up sorted alphabetically with the real match buried.
    const sql = dialect.sqlToQuery(buildAuthorMatchSource('king', 'broad')).sql;
    expect(sql).toMatch(/0 as tier/i);
    expect(sql).toMatch(/1 as tier/i);
    expect(sql).toMatch(/union all/i);
  });
});
