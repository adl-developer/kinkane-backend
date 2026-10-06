import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * Friend-request notifications, against a real Postgres.
 *
 * WHY THIS EXISTS. Each follow request owns exactly one stored
 * `friend_request` notification for its receiver, and the two must never
 * disagree: created together, status mirrored on accept/decline, revived on a
 * resend, and gone when the request is withdrawn. Half of that is enforced by
 * the database (the unique index, the FK cascade, the transaction), so a
 * mocked database would only prove we wrote the calls we wrote.
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

// The service fans out email and push through BullMQ; keep these tests off
// Redis entirely.
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let usersService: typeof import('../services/users.service').usersService;
let notificationsService: typeof import('../services/notifications.service').notificationsService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'fr-notif-test-';

describeIfDb('friend-request notifications', () => {
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ usersService } = await import('../services/users.service'));
    ({ notificationsService } = await import('../services/notifications.service'));
  });

  async function cleanUp(): Promise<void> {
    // Cascades through follow_requests and notifications.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function createUser(name: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES (${name}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function requestId(): Promise<number> {
    const [row] = (await db.execute(
      sql`SELECT id FROM follow_requests WHERE sender_id = ${alice} AND receiver_id = ${bob}`,
    )) as unknown as { id: number }[];
    return row.id;
  }

  async function bobsFeed() {
    return notificationsService.list(bob, 20, 0);
  }

  beforeEach(async () => {
    await cleanUp();
    alice = await createUser('Alice');
    bob = await createUser('Bob');
  });

  afterAll(async () => {
    if (!testUrl) return;
    await cleanUp();
  });

  it('stores an unread notification with a numeric id when a request is sent', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const id = await requestId();

    const feed = await bobsFeed();
    expect(feed.total).toBe(1);
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications[0]).toMatchObject({
      type: 'friend_request',
      readAt: null,
      data: { followRequestId: id, senderId: alice, senderName: 'Alice', senderPhotoUrl: null, status: 'pending' },
    });
    expect(typeof feed.notifications[0].id).toBe('number');
  });

  it('mirrors an accept onto the notification and marks it read', async () => {
    await usersService.sendFollowRequest(alice, bob);
    await usersService.acceptFollowRequest(await requestId(), bob);

    const feed = await bobsFeed();
    expect(feed.unreadCount).toBe(0);
    expect(feed.notifications[0].data.status).toBe('accepted');
    expect(feed.notifications[0].readAt).not.toBeNull();
  });

  it('mirrors a decline, then revives the same row as unread on a resend', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const id = await requestId();
    const [{ id: notifId }] = (await bobsFeed()).notifications;

    await usersService.declineFollowRequest(id, bob);
    expect((await bobsFeed()).notifications[0].data.status).toBe('declined');

    await usersService.sendFollowRequest(alice, bob);
    const feed = await bobsFeed();
    expect(feed.total).toBe(1);
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications[0]).toMatchObject({ id: notifId, readAt: null, data: { status: 'pending' } });
  });

  it('removes the notification when the request is withdrawn', async () => {
    await usersService.sendFollowRequest(alice, bob);
    await usersService.withdrawFollowRequest(alice, bob);

    expect((await bobsFeed()).total).toBe(0);
  });

  it('lets only one of two racing accept/decline calls win, and the notification agrees', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const id = await requestId();

    const results = await Promise.allSettled([
      usersService.acceptFollowRequest(id, bob),
      usersService.declineFollowRequest(id, bob),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const [row] = (await db.execute(
      sql`SELECT status::text AS status FROM follow_requests WHERE id = ${id}`,
    )) as unknown as { status: string }[];
    expect((await bobsFeed()).notifications[0].data.status).toBe(row.status);
  });

  it('can be marked read like any other notification', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const [{ id }] = (await bobsFeed()).notifications;

    await notificationsService.markRead(bob, [id]);
    const feed = await bobsFeed();
    expect(feed.unreadCount).toBe(0);
    expect(feed.notifications[0].data.status).toBe('pending');
  });
});
