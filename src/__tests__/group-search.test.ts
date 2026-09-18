import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildGroupSearchCondition, buildGroupSearchOrderBy } from '../services/groups.service';

// Group search has to rank the way user and post search already do — the
// Community "Groups" tab and the Explore Books|Authors|Groups toggle sit next to
// those results, and a different formula would mean the same query ranks
// differently depending on which tab you are on. These pin the properties that
// keep the two in step, and the ones that keep the query on its indexes.
//
// The technique is author-search.test.ts's: compile the Drizzle SQL to a string
// and assert on its shape, so none of this needs a database.

const dialect = new PgDialect();
const condition = (q: string) => dialect.sqlToQuery(buildGroupSearchCondition(q)).sql;
const orderBy = (q: string) => buildGroupSearchOrderBy(q).map((s) => dialect.sqlToQuery(s).sql).join(' , ');

describe('group search condition', () => {
  it('matches on a prefix, a word prefix and trigram similarity', () => {
    const sql = condition('midnight');
    expect(sql).toMatch(/ilike/i);
    expect(sql).toMatch(/word_similarity/);
  });

  it('adds full text only once the query is long enough', () => {
    // plainto_tsquery on one or two characters matches almost nothing useful
    // while still costing an index probe; the prefix tiers carry short queries.
    expect(condition('mi')).not.toMatch(/plainto_tsquery/);
    expect(condition('mid')).toMatch(/plainto_tsquery/);
  });

  it('searches the simple dictionary, not english', () => {
    // Group names are names. Stemming would match "Reader" to "Reading", and it
    // has to agree with the generated search_vector column, which the migration
    // builds with 'simple'.
    expect(condition('midnight')).toContain("'simple'");
    expect(condition('midnight')).not.toContain("'english'");
  });

  it('uses word_similarity, not similarity', () => {
    // Only word_similarity is servable by the gin_trgm_ops index on name. The
    // two read almost identically in a diff and behave very differently at scale.
    expect(condition('midnight')).not.toMatch(/[^_]similarity\(/);
  });

  it('parameterises the query term rather than inlining it', () => {
    // An inlined term would be an injection vector and would also defeat plan
    // caching. Compiled SQL should carry placeholders, not the word itself.
    expect(condition("midnight'); drop table groups;--")).not.toContain('drop table');
  });
});

describe('group search ordering', () => {
  it('ranks with one branch per tier in the matching condition', () => {
    // If the CASE and the WHERE drift apart, rows still match but come back in
    // an order that looks arbitrary — much harder to spot than a missing result.
    const sql = orderBy('midnight');
    const branches = (sql.match(/when /gi) ?? []).length;
    expect(branches).toBe(3); // prefix, word prefix, trigram; full text is the ELSE
  });

  it('breaks ties by similarity and then by text rank', () => {
    const sql = orderBy('midnight');
    expect(sql.indexOf('word_similarity')).toBeLessThan(sql.indexOf('ts_rank'));
  });

  it('never sorts on a computed expression the index cannot serve first', () => {
    // The leading CASE is the cheap, index-backed discriminator; similarity and
    // ts_rank only reorder within a tier.
    expect(orderBy('midnight').trimStart().toLowerCase().startsWith('case')).toBe(true);
  });
});
