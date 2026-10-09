import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * Usernames and @mentions, against a real Postgres.
 *
 * WHY THIS EXISTS. Most of what makes mentions correct lives in the database:
 * the unique index that decides who gets a contested username, the FK cascades
 * that clean up a deleted comment's mentions, the claim-by-UPDATE that stops a
 * notification going out twice, and the visibility joins that decide whether a
 * mention in a private group may show its text. A mocked database would only
 * prove we wrote the calls we wrote.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users, and `.env` points at production. Skips itself when unset; refuses to
 * run when it names the same database as `.env`. Setup as in
 * friend-request-notifications.integration.test.ts.
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

// Keep these tests off Redis and off the network: the signup path enqueues
// emails, notifications enqueue pushes, and neither is what is under test.
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));

type Db = typeof import('../db').db;
let db: Db;
let sql: typeof import('drizzle-orm').sql;
let communityService: typeof import('../services/community.service').communityService;
let groupsService: typeof import('../services/groups.service').groupsService;
let groupBooksService: typeof import('../services/group-books.service').groupBooksService;
let userBooksService: typeof import('../services/user-books.service').userBooksService;
let mentionsService: typeof import('../services/mentions.service').mentionsService;
let usernamesService: typeof import('../services/usernames.service').usernamesService;
let suggestions: typeof import('../services/mention-suggestions.service').mentionSuggestionsService;
let authService: typeof import('../services/auth.service').authService;
let enqueuePush: ReturnType<typeof vi.fn>;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'mention-test-';
const BOOK_REF = 'mention-test-book';

describeIfDb('usernames and mentions', () => {
  let ama: number;
  let kofi: number;
  let esi: number;
  let bookId: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communityService } = await import('../services/community.service'));
    ({ groupsService } = await import('../services/groups.service'));
    ({ groupBooksService } = await import('../services/group-books.service'));
    ({ userBooksService } = await import('../services/user-books.service'));
    ({ mentionsService } = await import('../services/mentions.service'));
    ({ usernamesService } = await import('../services/usernames.service'));
    ({ mentionSuggestionsService: suggestions } = await import('../services/mention-suggestions.service'));
    ({ authService } = await import('../services/auth.service'));
    enqueuePush = (await import('../lib/push-queue')).enqueuePush as unknown as ReturnType<typeof vi.fn>;

    // Notifications are sent in the background in production. Here they are
    // captured instead, and each test runs them with flushDispatches() when it
    // wants them sent — so it can assert on the outcome without racing a
    // promise nobody awaits, and with exactly the options the write passed.
    vi.spyOn(mentionsService, 'dispatchInBackground').mockImplementation(() => {});

    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Beloved') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
  });

  async function cleanUp(): Promise<void> {
    // Cascades through posts, comments, groups, shelves, mentions and notifications.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function createUser(name: string, username: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, username, email, email_verified)
      VALUES (${name}, ${username}, ${`${EMAIL_PREFIX}${username}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function befriend(a: number, b: number): Promise<void> {
    await db.execute(sql`INSERT INTO follow_requests (sender_id, receiver_id, status) VALUES (${a}, ${b}, 'accepted')`);
  }

  async function mentionNotifications(userId: number) {
    return (await db.execute(sql`
      SELECT data FROM notifications WHERE user_id = ${userId} AND type = 'mention' ORDER BY id
    `)) as unknown as { data: Record<string, unknown> }[];
  }

  async function mentionRows(userId: number) {
    return (await db.execute(sql`
      SELECT id, post_id, comment_id, group_comment_id, notified_at, removed_at FROM mentions WHERE mentioned_user_id = ${userId}
    `)) as unknown as {
      id: number; post_id: number | null; comment_id: number | null; group_comment_id: number | null;
      notified_at: Date | null; removed_at: Date | null;
    }[];
  }

  /** Runs every dispatch the writes so far handed to the background, as they asked, and forgets them. */
  async function flushDispatches(): Promise<void> {
    const background = vi.mocked(mentionsService.dispatchInBackground);
    const calls = [...background.mock.calls];
    background.mockClear();
    for (const [sources, options] of calls) {
      for (const source of sources) await mentionsService.dispatch(source, options);
    }
  }

  beforeEach(async () => {
    await cleanUp();
    enqueuePush.mockClear();
    vi.mocked(mentionsService.dispatchInBackground).mockClear();
    ama = await createUser('Ama Owusu', 'mt_ama');
    kofi = await createUser('Kofi Mensah', 'mt_kofi');
    esi = await createUser('Esi Boateng', 'mt_esi');
  });

  afterAll(async () => {
    if (!testUrl) return;
    await cleanUp();
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  });

  // ── Usernames ──────────────────────────────────────────────────────────────

  describe('signup', () => {
    const password = 'Str0ng!pass';

    it('keeps a chosen username, normalized', async () => {
      const { user } = await authService.signup('Yaw', `${EMAIL_PREFIX}yaw@example.com`, password, undefined, {
        username: '@MT_Yaw',
      });
      expect(user.username).toBe('mt_yaw');
    });

    it('refuses a taken username with 409 USERNAME_TAKEN and creates no account', async () => {
      await expect(
        authService.signup('Other Ama', `${EMAIL_PREFIX}other@example.com`, password, undefined, { username: 'mt_ama' }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'USERNAME_TAKEN' });

      const rows = (await db.execute(sql`SELECT 1 FROM users WHERE email = ${`${EMAIL_PREFIX}other@example.com`}`)) as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('generates one from the display name when none is chosen', async () => {
      const { user } = await authService.signup('Zoë Ångström', `${EMAIL_PREFIX}zoe@example.com`, password, undefined, {});
      expect(user.username).toMatch(/^zoeangstrom(\d{2,5})?$/);
    });
  });

  describe('changing a username', () => {
    it('holds the old name for its owner, and nobody else can take it', async () => {
      await usernamesService.change(ama, 'mt_ama2');

      expect(await usernamesService.checkAvailability('mt_ama', kofi)).toMatchObject({ available: false, reason: 'taken' });
      await expect(usernamesService.change(kofi, 'mt_ama')).rejects.toMatchObject({ statusCode: 409, code: 'USERNAME_TAKEN' });
    });

    it('enforces the cooldown after a change', async () => {
      await usernamesService.change(ama, 'mt_ama2');
      await expect(usernamesService.change(ama, 'mt_ama3')).rejects.toMatchObject({
        statusCode: 429,
        code: 'USERNAME_CHANGE_TOO_SOON',
      });
      expect(await usernamesService.checkAvailability('mt_ama3', ama)).toMatchObject({ available: false, reason: 'too_soon' });
    });

    it('reports your own name as available and current', async () => {
      expect(await usernamesService.checkAvailability('MT_AMA', ama)).toEqual({ username: 'mt_ama', available: true, current: true });
    });

    it('lets you take your old name back inside the cooldown, without restarting it or extending the hold', async () => {
      const first = await usernamesService.change(ama, 'mt_ama2');
      const [heldBefore] = (await db.execute(sql`
        SELECT expires_at FROM username_holds WHERE username = 'mt_ama'
      `)) as unknown as { expires_at: Date }[];

      expect(await usernamesService.checkAvailability('mt_ama', ama)).toEqual({ username: 'mt_ama', available: true });
      const undo = await usernamesService.change(ama, 'mt_ama');
      expect(undo.username).toBe('mt_ama');
      expect(undo.usernameChangedAt).toEqual(first.usernameChangedAt);

      // The name stepped off is held only as long as the reclaimed one would have been.
      const [heldAfter] = (await db.execute(sql`
        SELECT user_id, expires_at FROM username_holds WHERE username = 'mt_ama2'
      `)) as unknown as { user_id: number; expires_at: Date }[];
      expect(heldAfter).toMatchObject({ user_id: ama, expires_at: heldBefore.expires_at });

      // Any other change still waits for the cooldown.
      await expect(usernamesService.change(ama, 'mt_ama3')).rejects.toMatchObject({ code: 'USERNAME_CHANGE_TOO_SOON' });
    });

    it('lets the first change happen at once — a generated name was never chosen', async () => {
      await expect(usernamesService.change(kofi, 'mt_kofi.reads')).resolves.toMatchObject({ username: 'mt_kofi.reads' });
    });
  });

  // ── Mentions ───────────────────────────────────────────────────────────────

  it('stores a mention by id, renders it as the current username, and follows a rename', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: 'You have to read this, @MT_Ama.', isPublic: true,
    });

    const [stored] = (await db.execute(sql`SELECT body FROM posts WHERE id = ${postId}`)) as unknown as { body: string }[];
    expect(stored.body).toBe(`You have to read this, @{{u:${ama}}}.`);

    const post = await communityService.getPost(postId, esi);
    expect(post.body).toBe('You have to read this, @mt_ama.');
    expect(post.mentions).toEqual([{ userId: ama, username: 'mt_ama', start: 23, length: 7 }]);

    await usernamesService.change(ama, 'mt_ama.reads');
    expect((await communityService.getPost(postId, esi)).body).toBe('You have to read this, @mt_ama.reads.');
  });

  it('notifies a mention in a public post once, with an excerpt, and not again on an edit that keeps it', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: 'Loved it @mt_ama', isPublic: true,
    });
    expect(await mentionsService.dispatch({ type: 'post', id: postId })).toBe(1);

    const [n] = await mentionNotifications(ama);
    expect(n.data).toMatchObject({
      sourceType: 'post', postId, bookTitle: 'Beloved', mentionerId: kofi, mentionerUsername: 'mt_kofi',
      excerpt: 'Loved it @mt_ama', restricted: false,
    });
    expect(enqueuePush).toHaveBeenCalledWith('mention', expect.objectContaining({ userId: ama, where: 'a review of Beloved' }));

    await communityService.updatePost(postId, kofi, { body: 'Loved it, @mt_ama — and @mt_esi too' });
    await mentionsService.dispatch({ type: 'post', id: postId });
    expect(await mentionNotifications(ama)).toHaveLength(1);
    expect(await mentionNotifications(esi)).toHaveLength(1);
  });

  it('removes the mention when an edit takes it out', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 4, status: 'read', body: 'cc @mt_ama', isPublic: true,
    });
    expect(await mentionRows(ama)).toHaveLength(1);

    await communityService.updatePost(postId, kofi, { body: 'never mind' });
    expect(await mentionRows(ama)).toHaveLength(0);
  });

  it('does not store or notify a self-mention, but still links it', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 4, status: 'read', body: 'note to self @mt_kofi', isPublic: true,
    });
    expect(await mentionRows(kofi)).toHaveLength(0);
    expect((await communityService.getPost(postId, kofi)).mentions).toHaveLength(1);
  });

  it('holds back a mention in a private post until the post is made public', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 3, status: 'reading', body: 'what would @mt_ama think', isPublic: false,
    });
    await communityService.addComment(postId, kofi, 'and @mt_esi?');

    expect(await mentionsService.dispatch({ type: 'post', id: postId })).toBe(0);
    expect(await mentionNotifications(ama)).toHaveLength(0);
    expect((await mentionRows(ama))[0].notified_at).toBeNull();

    await flushDispatches();
    await communityService.updatePost(postId, kofi, { isPublic: true });
    await flushDispatches();

    expect(await mentionNotifications(ama)).toHaveLength(1);
    expect(await mentionNotifications(esi)).toHaveLength(1);
  });

  it('tells a non-member they were mentioned in a private group, without showing the text', async () => {
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'private' });
    const shelf = await groupBooksService.setCurrent(group.id, kofi, { bookId, startedOn: '2026-10-01' });
    const comment = await groupBooksService.addComment(group.id, shelf.id, kofi, 'Secret plans for @mt_esi');

    // The author sees it rendered.
    expect(comment.body).toBe('Secret plans for @mt_esi');
    expect(comment.mentions).toEqual([{ userId: esi, username: 'mt_esi', start: 17, length: 7 }]);

    await mentionsService.dispatch({ type: 'group_comment', id: comment.id });
    const [n] = await mentionNotifications(esi);
    expect(n.data).toMatchObject({ sourceType: 'group_comment', groupName: 'Night Readers', excerpt: null, restricted: true });
    expect(n.data).not.toHaveProperty('groupCommentId');
    expect(enqueuePush).toHaveBeenCalledWith('mention', expect.objectContaining({ where: 'Night Readers, a private group' }));

    const feed = await mentionsService.list(esi, 20, 0);
    expect(feed.total).toBe(1);
    expect(feed.mentions[0]).toMatchObject({ restricted: true, excerpt: null, target: { groupId: group.id, groupName: 'Night Readers' } });
  });

  it('shows a member the excerpt in the same private group', async () => {
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'private' });
    await db.execute(sql`
      INSERT INTO group_memberships (group_id, user_id, status, joined_at) VALUES (${group.id}, ${ama}, 'active', now())
    `);
    const shelf = await groupBooksService.setCurrent(group.id, kofi, { bookId, startedOn: '2026-10-01', description: 'Led by @mt_ama' });
    expect(shelf.description).toBe('Led by @mt_ama');
    expect(shelf.descriptionMentions).toHaveLength(1);

    await mentionsService.dispatch({ type: 'group_book', id: shelf.id });
    const [n] = await mentionNotifications(ama);
    expect(n.data).toMatchObject({ sourceType: 'group_book', excerpt: 'Led by @mt_ama', restricted: false });
  });

  it('marks a mention handled but sends nothing when the person has mentions switched off', async () => {
    await db.execute(sql`INSERT INTO notification_preferences (user_id, mentions) VALUES (${ama}, false)`);
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: '@mt_ama', isPublic: true,
    });
    expect(await mentionsService.dispatch({ type: 'post', id: postId })).toBe(0);
    expect(await mentionNotifications(ama)).toHaveLength(0);
    // Handled, so switching notifications back on does not release a backlog.
    expect((await mentionRows(ama))[0].notified_at).not.toBeNull();
  });

  it('is safe to dispatch twice at once — nobody is told twice', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: '@mt_ama', isPublic: true,
    });
    const source = { type: 'post' as const, id: postId };
    const sent = await Promise.all([mentionsService.dispatch(source), mentionsService.dispatch(source)]);
    expect(sent[0] + sent[1]).toBe(1);
    expect(await mentionNotifications(ama)).toHaveLength(1);
  });

  it('does not also send a mention to the post owner for a comment on their post — they get the comment notification', async () => {
    const { id: postId } = await communityService.createPost(kofi, { bookId, rating: 5, status: 'read', isPublic: true });
    await communityService.addComment(postId, esi, '@mt_kofi @mt_ama look');
    await flushDispatches();
    expect(await mentionNotifications(kofi)).toHaveLength(0);
    expect(await mentionNotifications(ama)).toHaveLength(1);
  });

  it('does mention the post owner when an edit adds them — an edit sends no comment notification', async () => {
    const { id: postId } = await communityService.createPost(kofi, { bookId, rating: 5, status: 'read', isPublic: true });
    const { id: commentId } = await communityService.addComment(postId, esi, 'agree');
    await communityService.updateComment(commentId, esi, 'agree — @mt_kofi what did you make of the ending?');
    await flushDispatches();
    expect(await mentionNotifications(kofi)).toHaveLength(1);
  });

  it('mentions a post owner who has comment notifications off — nothing else would tell them', async () => {
    await db.execute(sql`INSERT INTO notification_preferences (user_id, comments) VALUES (${kofi}, false)`);
    const { id: postId } = await communityService.createPost(kofi, { bookId, rating: 5, status: 'read', isPublic: true });
    await communityService.addComment(postId, esi, '@mt_kofi look');
    await flushDispatches();
    expect(await mentionNotifications(kofi)).toHaveLength(1);
  });

  it('never notifies twice when an edit takes a mention out and puts it back', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: 'with @mt_ama', isPublic: true,
    });
    await flushDispatches();
    expect(await mentionNotifications(ama)).toHaveLength(1);

    await communityService.updatePost(postId, kofi, { body: 'on my own' });
    const [removed] = await mentionRows(ama);
    expect(removed.removed_at).not.toBeNull();
    expect((await mentionsService.list(ama, 20, 0)).total).toBe(0);

    await communityService.updatePost(postId, kofi, { body: 'with @mt_ama again' });
    await flushDispatches();
    expect(await mentionNotifications(ama)).toHaveLength(1);
    expect(await mentionRows(ama)).toEqual([expect.objectContaining({ id: removed.id, removed_at: null })]);
    expect((await mentionsService.list(ama, 20, 0)).total).toBe(1);
  });

  it('holds a mention in a private shelf note until the note is made public', async () => {
    await userBooksService.upsert(kofi, bookId, { status: 'read', note: 'lend to @mt_ama', noteIsPublic: false });
    await flushDispatches();
    expect(await mentionNotifications(ama)).toHaveLength(0);

    await userBooksService.upsert(kofi, bookId, { noteIsPublic: true });
    await flushDispatches();
    const [n] = await mentionNotifications(ama);
    expect(n.data).toMatchObject({ sourceType: 'book_note', bookTitle: 'Beloved', excerpt: 'lend to @mt_ama', restricted: false });

    const [note] = await userBooksService.getPublicNotes(bookId);
    expect(note).toMatchObject({ note: 'lend to @mt_ama', userUsername: 'mt_kofi' });
    expect(note.noteMentions).toEqual([{ userId: ama, username: 'mt_ama', start: 8, length: 7 }]);
  });

  it('shows a group description mention to anyone, even for a private group — the description is public', async () => {
    const group = await groupsService.create(kofi, { name: 'Quiet Club', description: 'Founded with @mt_esi', privacy: 'private' });
    expect(group.description).toBe('Founded with @mt_esi');
    expect(group.descriptionMentions).toEqual([{ userId: esi, username: 'mt_esi', start: 13, length: 7 }]);

    await flushDispatches();
    const [n] = await mentionNotifications(esi);
    expect(n.data).toMatchObject({ sourceType: 'group', groupName: 'Quiet Club', excerpt: 'Founded with @mt_esi', restricted: false });
  });

  it('skips all mention bookkeeping for a new text that mentions nobody', async () => {
    await communityService.createPost(kofi, { bookId, rating: 5, status: 'read', body: 'no one here', isPublic: true });
    expect(vi.mocked(mentionsService.dispatchInBackground)).not.toHaveBeenCalled();
  });

  it('cleans up a deleted comment’s mentions through the foreign key', async () => {
    const { id: postId } = await communityService.createPost(kofi, { bookId, rating: 5, status: 'read', isPublic: true });
    const { id: commentId } = await communityService.addComment(postId, esi, 'agree with @mt_ama');
    expect(await mentionRows(ama)).toHaveLength(1);

    await communityService.deleteComment(commentId, esi);
    expect(await mentionRows(ama)).toHaveLength(0);
  });

  it('renders a deleted account’s mention as @deleted, unlinked', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: 'thanks @mt_esi', isPublic: true,
    });
    await db.execute(sql`DELETE FROM users WHERE id = ${esi}`);
    const post = await communityService.getPost(postId, ama);
    expect(post.body).toBe('thanks @deleted');
    expect(post.mentions).toEqual([]);
  });

  it('leaves a handle nobody holds as plain text', async () => {
    const { id: postId } = await communityService.createPost(kofi, {
      bookId, rating: 5, status: 'read', body: 'hi @mt_nobody', isPublic: true,
    });
    const post = await communityService.getPost(postId, ama);
    expect(post.body).toBe('hi @mt_nobody');
    expect(post.mentions).toEqual([]);
  });

  describe('suggestions', () => {
    it('ranks friends first and matches usernames and display names', async () => {
      const yaa = await createUser('Esi Yaa', 'mt_yaa');
      await befriend(ama, yaa);

      const result = await suggestions.suggest(ama, 'es');
      expect(result.map((u) => u.username)).toEqual(['mt_yaa', 'mt_esi']);

      const byHandle = await suggestions.suggest(ama, '@mt_k');
      expect(byHandle.map((u) => u.username)).toEqual(['mt_kofi']);
    });

    it('treats _ as a literal, not a LIKE wildcard', async () => {
      await createUser('Someone', 'mtxama');
      const result = await suggestions.suggest(kofi, 'mt_a');
      expect(result.map((u) => u.username)).toEqual(['mt_ama']);
    });

    it('with nothing typed, offers only the conversation and friends', async () => {
      await befriend(ama, kofi);
      const { id: postId } = await communityService.createPost(esi, { bookId, rating: 5, status: 'read', isPublic: true });
      const result = await suggestions.suggest(ama, '', { type: 'post', id: postId });
      expect(result.map((u) => u.username)).toEqual(['mt_esi', 'mt_kofi']);
    });

    it('never suggests you, or a guest', async () => {
      await db.execute(sql`
        INSERT INTO users (name, email, is_guest) VALUES ('Mt Guest', ${`${EMAIL_PREFIX}guest@example.com`}, true)
      `);
      const result = await suggestions.suggest(ama, 'mt');
      expect(result.map((u) => u.id)).not.toContain(ama);
      expect(result.every((u) => u.username)).toBe(true);
    });
  });
});
