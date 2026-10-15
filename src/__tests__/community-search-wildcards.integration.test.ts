import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * `%` and `_` in a search are characters to find, not LIKE wildcards, against a real Postgres.
 *
 * WHY THIS EXISTS. People, group and post search build ILIKE patterns from the
 * query. Unescaped, `%%%` matched every name and `___` every name of three or
 * more characters — the whole user or group table, ranked arbitrarily. Whether
 * the escape survives into the pattern is only visible in what Postgres returns.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users, and `.env` points at production. Skips itself when unset; refuses to
 * run when it names the same database as `.env`. Setup as in
 * nielsen-budget.integration.test.ts.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));

type Db = typeof import('../db').db;
let db: Db;
let sql: typeof import('drizzle-orm').sql;
let communitySearchService: typeof import('../services/community-search.service').communitySearchService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'search-wildcards-test-';

describeIfDb('community search: LIKE wildcards in the query are literal', () => {
  const userIds: number[] = [];
  const groupIds: number[] = [];
  let me: number;
  let percentUser: number;
  let percentGroup: number;

  async function search(q: string, filter: 'users' | 'groups') {
    const result = await communitySearchService.search(q, filter, me, 50, 0);
    return filter === 'users'
      ? result.users.map((u) => u.id).filter((id) => userIds.includes(id))
      : result.groups.map((g) => g.id).filter((id) => groupIds.includes(id));
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communitySearchService } = await import('../services/community-search.service'));

    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    // Groups go with their owner (ON DELETE CASCADE)
    for (const [key, name] of [['me', 'Ordinary Person'], ['other', 'Someone Else'], ['percent', '100% Reader']] as const) {
      const [row] = (await db.execute(sql`
        INSERT INTO users (name, email, email_verified)
        VALUES (${name}, ${`${EMAIL_PREFIX}${key}@example.com`}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      userIds.push(row.id);
      if (key === 'me') me = row.id;
      if (key === 'percent') percentUser = row.id;
    }
    for (const name of ['Quiet Readers Club', 'Night Owls', '100% Fiction']) {
      const [row] = (await db.execute(sql`
        INSERT INTO groups (owner_id, name) VALUES (${me}, ${name}) RETURNING id
      `)) as unknown as { id: number }[];
      groupIds.push(row.id);
      if (name.startsWith('100%')) percentGroup = row.id;
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });

  it('does not return every person for % or _', async () => {
    expect(await search('%%%', 'users')).toEqual([]);
    expect(await search('___', 'users')).toEqual([]);
  });

  it('does not return every group for % or _', async () => {
    expect(await search('%%%', 'groups')).toEqual([]);
    expect(await search('___', 'groups')).toEqual([]);
  });

  it('still finds a name that really contains the character', async () => {
    expect(await search('100%', 'users')).toContain(percentUser);
    expect(await search('100%', 'groups')).toContain(percentGroup);
  });
});
