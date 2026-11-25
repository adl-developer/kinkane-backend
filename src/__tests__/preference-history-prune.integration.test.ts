import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The nightly preference-history prune, against a real Postgres.
 *
 * Guards a bug only a real driver shows: the raw-SQL DELETE interpolated a JS
 * Date, which postgres-js rejects outside the query builder ("The "string"
 * argument must be ... Received an instance of Date"), so the cron failed every
 * night without deleting anything.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users. Skips itself when unset; refuses to run when it names the same
 * database as `.env`. Setup as in nielsen-budget.integration.test.ts.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  let configured: string | undefined;
  try {
    configured = dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    configured = undefined;
  }
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let service: typeof import('../services/preference-history.service').preferenceHistoryService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'pref-history-prune-test-';

describeIfDb('preference history prune', () => {
  let activeUser: number;
  let dormantUser: number;

  async function cleanUp(): Promise<void> {
    // History rows cascade with their user.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function user(name: string): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email) VALUES (${name}, ${`${EMAIL_PREFIX}${name}@example.com`}) RETURNING id
    `);
    return rows[0].id;
  }

  async function history(userId: number, recordedAt: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO user_preference_history (user_id, feelings, book_ids, genres, dislikes, changed_fields, source, recorded_at)
      VALUES (${userId}, '[]', '[]', '[]', '{}', '[]', 'onboarding', ${recordedAt}::timestamptz)
    `);
  }

  async function datesOf(userId: number): Promise<string[]> {
    const rows = await db.execute<{ recorded_at: string }>(sql`
      SELECT recorded_at::text FROM user_preference_history WHERE user_id = ${userId} ORDER BY recorded_at
    `);
    return rows.map((r) => r.recorded_at.slice(0, 10));
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ preferenceHistoryService: service } = await import('../services/preference-history.service'));

    await cleanUp();

    activeUser = await user('active');
    await history(activeUser, '2020-01-01T00:00:00Z');
    await history(activeUser, '2021-01-01T00:00:00Z');
    await history(activeUser, new Date().toISOString());

    // Set once, never touched again: the only row must survive however old.
    dormantUser = await user('dormant');
    await history(dormantUser, '2019-06-01T00:00:00Z');
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  it('deletes rows past retention but keeps each user\'s newest', async () => {
    const deleted = await service.pruneOlderThan(2);

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await datesOf(activeUser)).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(await datesOf(dormantUser)).toEqual(['2019-06-01']);
  });
});
