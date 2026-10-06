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
 * Also covers the feed that reads these rows and the clear endpoints, whose
 * one special case — a pending friend request can't be cleared — is decided
 * by follow_requests.
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

  beforeEach(async () => {
    await cleanUp();
    alice = await createUser('Alice');
    bob = await createUser('Bob');
  });

  afterAll(async () => {
    if (!testUrl) return;
    await cleanUp();
  });

  /** Bob's stored friend-request notification, read straight from the table. */
  async function storedRow() {
    const rows = (await db.execute(sql`
      SELECT id, follow_request_id, read_at, data FROM notifications
      WHERE user_id = ${bob} AND type = 'friend_request'
    `)) as unknown as { id: number; follow_request_id: number; read_at: Date | null; data: Record<string, unknown> }[];
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }

  it('stores an unread notification when a request is sent', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const id = await requestId();

    expect(await storedRow()).toMatchObject({
      follow_request_id: id,
      read_at: null,
      data: { followRequestId: id, senderId: alice, senderName: 'Alice', senderPhotoUrl: null, status: 'pending' },
    });
  });

  it('mirrors an accept onto the notification and marks it read', async () => {
    await usersService.sendFollowRequest(alice, bob);
    await usersService.acceptFollowRequest(await requestId(), bob);

    const row = await storedRow();
    expect(row.data.status).toBe('accepted');
    expect(row.read_at).not.toBeNull();
  });

  it('mirrors a decline, then revives the same row as unread on a resend', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const id = await requestId();
    const { id: notifId } = await storedRow();

    await usersService.declineFollowRequest(id, bob);
    expect((await storedRow()).data.status).toBe('declined');

    await usersService.sendFollowRequest(alice, bob);
    expect(await storedRow()).toMatchObject({ id: notifId, read_at: null, data: { status: 'pending' } });
  });

  it('removes the notification when the request is withdrawn', async () => {
    await usersService.sendFollowRequest(alice, bob);
    await usersService.withdrawFollowRequest(alice, bob);

    expect(await storedRow()).toBeUndefined();
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
    expect((await storedRow()).data.status).toBe(row.status);
  });

  it('answers a resend racing a withdraw with a 4xx, never an orphaned notification', async () => {
    // Without the guard on the resend UPDATE, a withdraw landing between the
    // decision and the write left the notification pointing at a deleted
    // request, which the foreign key turned into a 500.
    for (let i = 0; i < 10; i++) {
      await usersService.sendFollowRequest(alice, bob);
      await usersService.declineFollowRequest(await requestId(), bob);

      const results = await Promise.allSettled([
        usersService.sendFollowRequest(alice, bob),
        usersService.withdrawFollowRequest(alice, bob),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect((r.reason as { statusCode?: number }).statusCode).toBeGreaterThanOrEqual(400);
          expect((r.reason as { statusCode?: number }).statusCode).toBeLessThan(500);
        }
      }

      const [{ n }] = (await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM follow_requests WHERE sender_id = ${alice} AND receiver_id = ${bob}`,
      )) as unknown as { n: number }[];
      expect(Boolean(await storedRow())).toBe(n === 1);

      await db.execute(sql`DELETE FROM follow_requests WHERE sender_id = ${alice}`);
    }
  });

  it('lists friend requests from the stored rows, with numeric ids and real read state', async () => {
    await usersService.sendFollowRequest(alice, bob);
    const { id } = await storedRow();

    let feed = await notificationsService.list(bob, 20, 0);
    expect(feed.total).toBe(1);
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications[0]).toMatchObject({ id, type: 'friend_request', readAt: null });

    await notificationsService.markRead(bob, [id]);
    feed = await notificationsService.list(bob, 20, 0);
    expect(feed.unreadCount).toBe(0);
    // Read is not cleared: the item stays in the feed.
    expect(feed.total).toBe(1);
  });

  it("shows the sender's current name and photo, not the ones saved when the request was sent", async () => {
    await usersService.sendFollowRequest(alice, bob);
    await db.execute(sql`UPDATE users SET name = 'Alicia', photo_url = NULL WHERE id = ${alice}`);

    const [item] = (await notificationsService.list(bob, 20, 0)).notifications;
    expect(item.data).toMatchObject({ senderName: 'Alicia', senderPhotoUrl: null, status: 'pending' });
  });

  describe('clearing', () => {
    async function addNotification(userId: number, read = false): Promise<number> {
      const [row] = (await db.execute(sql`
        INSERT INTO notifications (user_id, type, data, read_at)
        VALUES (${userId}, 'post_like', '{}'::jsonb, ${read ? sql`now()` : sql`NULL`})
        RETURNING id
      `)) as unknown as { id: number }[];
      return row.id;
    }

    it('clears one notification by id, read or unread', async () => {
      const unread = await addNotification(bob);
      const read = await addNotification(bob, true);
      const keep = await addNotification(bob);

      await notificationsService.clearOne(bob, unread);
      await notificationsService.clearOne(bob, read);

      const feed = await notificationsService.list(bob, 20, 0);
      expect(feed.notifications.map((n) => n.id)).toEqual([keep]);
    });

    it("404s on an id that isn't the caller's, and leaves it alone", async () => {
      const alicesId = await addNotification(alice);

      await expect(notificationsService.clearOne(bob, alicesId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(notificationsService.clearOne(bob, 999999999)).rejects.toMatchObject({ statusCode: 404 });
      expect((await notificationsService.list(alice, 20, 0)).total).toBe(1);
    });

    it('refuses to clear a pending friend request, and allows it once answered', async () => {
      await usersService.sendFollowRequest(alice, bob);
      const { id } = await storedRow();

      await expect(notificationsService.clearOne(bob, id)).rejects.toMatchObject({
        statusCode: 409,
        code: 'FRIEND_REQUEST_PENDING',
      });

      await usersService.declineFollowRequest(await requestId(), bob);
      await notificationsService.clearOne(bob, id);
      expect(await storedRow()).toBeUndefined();
    });

    it("clears everything of the caller's except pending friend requests", async () => {
      await addNotification(bob);
      await addNotification(bob, true);
      const alicesId = await addNotification(alice);
      await usersService.sendFollowRequest(alice, bob);

      expect(await notificationsService.clearAll(bob)).toEqual({ cleared: 2 });

      const feed = await notificationsService.list(bob, 20, 0);
      expect(feed.notifications.map((n) => n.type)).toEqual(['friend_request']);
      expect((await notificationsService.list(alice, 20, 0)).notifications.map((n) => n.id)).toEqual([alicesId]);
    });

    it('brings a cleared friend request back when it is re-sent', async () => {
      await usersService.sendFollowRequest(alice, bob);
      await usersService.declineFollowRequest(await requestId(), bob);
      await notificationsService.clearAll(bob);
      expect(await storedRow()).toBeUndefined();

      await usersService.sendFollowRequest(alice, bob);
      expect(await storedRow()).toMatchObject({ read_at: null, data: { status: 'pending' } });
    });
  });
});
