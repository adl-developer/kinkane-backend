import { sql, type SQL } from 'drizzle-orm';
import { apostropheVariants } from './escape-like';

/**
 * `plainto_tsquery(config, q)`, but matching whichever apostrophe a document was indexed
 * with. A tsvector keeps the apostrophe it was built from ("Segi’s" → `segi’`, "Segi's" →
 * `segi`), so a query typed with one never matches a book stored with the other — and iOS
 * sends `’` by default while most of the catalogue stores `'`. A query containing an
 * apostrophe is therefore OR'd across both spellings; one without is the plain call.
 *
 * Parenthesised because `@@` and `||` share a precedence level in Postgres and associate
 * left, so `v @@ a || b` would parse as `(v @@ a) || b`.
 */
export function plainTsQuery(config: 'english' | 'simple', q: string): SQL {
  const cfg = sql.raw(`'${config}'`);
  const [first, ...rest] = apostropheVariants(q);
  const query = rest.reduce(
    (acc, v) => sql`${acc} || plainto_tsquery(${cfg}, ${v})`,
    sql`plainto_tsquery(${cfg}, ${first})`,
  );
  return sql`(${query})`;
}
