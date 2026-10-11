import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * People search tells you where you stand with each person, against a real Postgres.
 *
 * WHY THIS EXISTS. Each user result carries `followStatus` (your request to
 * them) and `incomingFollowRequest` (theirs to you), read with two LEFT JOINs
 * onto the search query itself. A join that matched the wrong direction, or
 * multiplied rows, would still type-check and still return users. Only real
 * follow rows in every state show each person gets the right button, once.
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
const EMAIL_PREFIX = 'search-follow-test-';
// A surname no real account will share, so the search returns only these rows
const SURNAME = 'Quillfeather';

describeIfDb('community people search: follow status per result', () => {
  const ids: Record<string, number> = {};

  async function createUser(first: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES (${`${first} ${SURNAME}`}, ${`${EMAIL_PREFIX}${first.toLowerCase()}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function follow(sender: number, receiver: number, status: 'pending' | 'accepted' | 'declined'): Promise<void> {
    await db.execute(sql`
      INSERT INTO follow_requests (sender_id, receiver_id, status) VALUES (${sender}, ${receiver}, ${status})
    `);
  }

  async function searchPeople() {
    const result = await communitySearchService.search(SURNAME, 'users', ids.me, 50, 0);
    return { result, byId: new Map(result.users.map((u) => [u.id, u])) };
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communitySearchService } = await import('../services/community-search.service'));

    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    for (const first of ['Me', 'Stranger', 'Requested', 'Following', 'Declined', 'Asker', 'Mutual']) {
      ids[first.toLowerCase()] = await createUser(first);
    }
    await follow(ids.me, ids.requested, 'pending');
    await follow(ids.me, ids.following, 'accepted');
    await follow(ids.me, ids.declined, 'declined');
    await follow(ids.asker, ids.me, 'pending');
    // Both directions at once: I follow them, and they've asked to follow me
    await follow(ids.me, ids.mutual, 'accepted');
    await follow(ids.mutual, ids.me, 'pending');
    // Requests between other people must not leak into my results
    await follow(ids.stranger, ids.following, 'accepted');
    await follow(ids.requested, ids.stranger, 'pending');
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });

  it('gives each person my follow status toward them, matching the profile values', async () => {
    const { byId } = await searchPeople();
    expect(byId.get(ids.stranger)?.followStatus).toBe('none');
    expect(byId.get(ids.requested)?.followStatus).toBe('pending');
    expect(byId.get(ids.following)?.followStatus).toBe('accepted');
    expect(byId.get(ids.declined)?.followStatus).toBe('declined');
  });

  it('marks my own row as self', async () => {
    const { byId } = await searchPeople();
    expect(byId.get(ids.me)).toMatchObject({ followStatus: 'self', incomingFollowRequest: null });
  });

  it('shows a pending request they sent me, alongside my own status toward them', async () => {
    const { byId } = await searchPeople();
    expect(byId.get(ids.asker)).toMatchObject({
      followStatus: 'none',
      incomingFollowRequest: { requestId: expect.any(Number), requestedAt: expect.any(Date) },
    });
    expect(byId.get(ids.mutual)).toMatchObject({
      followStatus: 'accepted',
      incomingFollowRequest: { requestId: expect.any(Number) },
    });
    for (const key of ['stranger', 'requested', 'following', 'declined'] as const) {
      expect(byId.get(ids[key])?.incomingFollowRequest).toBeNull();
    }
  });

  it('returns each person exactly once, and the total still counts people, not follow rows', async () => {
    const { result } = await searchPeople();
    const returned = result.users.map((u) => u.id);
    expect(new Set(returned).size).toBe(returned.length);
    expect(returned.sort()).toEqual(Object.values(ids).sort());
    expect(result.total.users).toBe(Object.keys(ids).length);
  });

  it('reads the status for whoever is searching, not a fixed viewer', async () => {
    const result = await communitySearchService.search(SURNAME, 'users', ids.stranger, 50, 0);
    const byId = new Map(result.users.map((u) => [u.id, u]));
    expect(byId.get(ids.stranger)?.followStatus).toBe('self');
    expect(byId.get(ids.following)?.followStatus).toBe('accepted');
    expect(byId.get(ids.me)?.followStatus).toBe('none');
    expect(byId.get(ids.requested)?.incomingFollowRequest).not.toBeNull();
  });
});
