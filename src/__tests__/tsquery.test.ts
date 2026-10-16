import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { plainTsQuery } from '../lib/tsquery';

const dialect = new PgDialect();

describe('plainTsQuery', () => {
  it('is the plain call when the query has no apostrophe', () => {
    const { sql, params } = dialect.sqlToQuery(plainTsQuery('english', 'baba segi'));
    expect(sql).toBe("(plainto_tsquery('english', $1))");
    expect(params).toEqual(['baba segi']);
  });

  it('ORs both apostrophe spellings, parenthesised so @@ binds to the whole query', () => {
    const { sql, params } = dialect.sqlToQuery(plainTsQuery('simple', 'baba segi’s'));
    expect(sql).toBe("(plainto_tsquery('simple', $1) || plainto_tsquery('simple', $2))");
    expect(params).toEqual(["baba segi's", 'baba segi’s']);
  });
});
