import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { buildPostSearchCondition, postsWithMatchingComment } from '../services/community-search.service';

// Post search has to stay on its indexes. An OR that mixes the joined books
// row with posts columns can use neither table's indexes, which made every
// search run the text and title tests once per public post (about 625 ms for
// one rare word over 100k posts, against 54 ms with this shape). These pin the
// shape that keeps each side in its own subquery. Compiled to SQL text, as in
// group-search.test.ts, so no database is needed.

const dialect = new PgDialect();
const compiled = (q: string) => dialect.sqlToQuery(buildPostSearchCondition(q, sql`comment_hit`)).sql;

describe('post search condition', () => {
  it('matches post text in a subquery over posts alone', () => {
    const sql = compiled('gripping');
    expect(sql).toMatch(/"posts"\."id" in \(select "id" from "posts" "text_match" where/);
    // Neither text column is tested on the outer, joined row
    expect(sql).not.toMatch(/"posts"\."search_text"/);
    expect(sql).not.toMatch(/"posts"\."search_vector"/);
  });

  it('tests the title once per book that has posts, in its own subquery', () => {
    const sql = compiled('gripping');
    expect(sql).toMatch(/"posts"\."book_id" in \(select "id" from "books" "title_match"/);
    expect(sql).toMatch(/"title_match"\."id" in \(select distinct "book_id" from "posts"\)/);
    expect(sql).not.toMatch(/"books"\."title"/);
  });

  it('matches comments once, as a derived table of visible comments on public posts', () => {
    const hits = dialect.sqlToQuery(sql`${postsWithMatchingComment('gripping', 1)}`).sql;
    expect(hits).toMatch(/^\(select distinct "comments"\."post_id" from "comments" inner join "posts" "comment_post"/);
    expect(hits).toMatch(/"comment_post"\."is_public" = \$\d/);
    expect(hits).toMatch(/"comments"\."hidden_at" is null/);
    // The condition only reads the caller's hit flag; no comment subquery of its own
    expect(compiled('gripping')).toContain('comment_hit');
    expect(compiled('gripping')).not.toMatch(/"comments"/);
  });

  it('cleans the typed text with the same function as the stored column', () => {
    expect(compiled('gripping')).toContain('post_search_text(');
  });
});
