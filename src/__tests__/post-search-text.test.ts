import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { MENTION_TOKEN_RE } from '../lib/mention-text';
import { LINK_TOKEN_RE } from '../lib/link-text';

// post_search_text() blanks out stored @mention and link tokens before post
// text is indexed for search. Its pattern is SQL in a migration and the token
// formats are TypeScript regexes, so nothing ties them together: change the
// token format and search silently starts indexing account and link ids. This
// pins the latest definition of the function to the two regexes.

/** The newest migration that (re)defines post_search_text — the one in force. */
function latestDefinition(): string {
  const dir = join(__dirname, '../../drizzle');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const defining = files.filter((f) => readFileSync(join(dir, f), 'utf8').includes('FUNCTION post_search_text'));
  expect(defining.length).toBeGreaterThan(0);
  return readFileSync(join(dir, defining[defining.length - 1]), 'utf8');
}

describe('post_search_text token pattern', () => {
  it('is the mention and link token regexes, character for character', () => {
    // Postgres ARE has \d, but the migration spells it [0-9]; translate back
    const expected = `${MENTION_TOKEN_RE.source}|${LINK_TOKEN_RE.source}`.replace(/\\d/g, '[0-9]');
    const sql = latestDefinition();
    expect(sql).toContain(`'${expected}', ' ', 'g'`);
  });
});
