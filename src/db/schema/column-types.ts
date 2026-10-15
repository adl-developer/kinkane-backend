import { customType } from 'drizzle-orm/pg-core';

/**
 * A Postgres tsvector column. Every one in this schema is filled by the
 * database — a trigger (books, users) or GENERATED ALWAYS (groups, posts) —
 * and never written from the app. It is declared on the table anyway so the
 * schema-vs-database column diff in endpoints.contract.test.ts doesn't report
 * it as undeclared.
 *
 * Not exported from index.ts: it is a column type, not a table.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});
