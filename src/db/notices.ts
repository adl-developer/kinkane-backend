import type postgres from 'postgres';

/**
 * What the app's Postgres client does with a NOTICE.
 *
 * Postgres raises one whenever a text search has nothing to search for, e.g.
 * a search for "the" or "a": every word is an English stop word, so
 * plainto_tsquery yields an empty query ("text-search query contains only stop
 * words or doesn't contain lexemes, ignored", or "…doesn't contain lexemes" for
 * an empty one). That is an ordinary search, not an event, and Community search
 * runs such queries for every short word typed, so these are dropped.
 *
 * Everything else is printed as postgres.js would print it with no handler
 * set, so no other notice changes how it surfaces.
 */
export function onNotice(notice: postgres.Notice): void {
  if (notice.message?.startsWith('text-search query ')) return;
  console.log(notice); // eslint-disable-line no-console
}
