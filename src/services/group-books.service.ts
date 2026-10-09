import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  groups,
  groupMemberships,
  groupBooks,
  groupBookComments,
  groupBookCommentLikes,
  books,
  bookContributors,
  bookGenres,
  genres,
  users,
  type GroupBookStatus,
} from '../db/schema';
import { groupViewerCapabilities, type ViewerCapabilities } from './groups.service';
import { addDisplayGenre, type GenreRef } from '../lib/genre-display';
import type { HttpError } from '../lib/route-helpers';
import { mentionsService, renderTexts } from './mentions.service';
import type { MentionRef } from '../lib/mention-text';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The book as a shelf row draws it: cover, title, author, genre chips. */
export interface GroupBookCard {
  id: number;
  isbn13: string | null;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  authors: string[];
  genres: GenreRef[];
}

export interface GroupShelfItem {
  /** The shelf entry's id — what the edit, finish, remove and comment routes take. */
  id: number;
  status: GroupBookStatus;
  book: GroupBookCard;
  description: string | null;
  /** Linked @handles in `description`. */
  descriptionMentions: MentionRef[];
  startedOn: string | null;
  finishedOn: string | null;
  addedAt: Date;
  /** Every comment and reply on this book. The 💬 count on the group page. */
  commentCount: number;
}

export interface GroupShelfSummary {
  currentlyReading: GroupShelfItem | null;
  wantToReadCount: number;
  finishedCount: number;
}

export interface ListGroupBooksOptions {
  status: GroupBookStatus;
  sort: 'title_asc' | 'title_desc' | 'date_asc' | 'date_desc';
  limit: number;
  offset: number;
}

export type AddBookSkipReason = 'not_found' | 'already_on_shelf';

export interface AddBooksResult {
  added: { id: number; bookId: number }[];
  skipped: { bookId: number; reason: AddBookSkipReason; status?: GroupBookStatus }[];
}

export interface SetCurrentInput {
  bookId: number;
  startedOn: string;
  description?: string | null;
}

export interface UpdateGroupBookInput {
  startedOn?: string;
  finishedOn?: string;
  description?: string | null;
}

export interface GroupCommentItem {
  id: number;
  groupBookId: number;
  parentId: number | null;
  userId: number;
  userName: string;
  userUsername: string | null;
  userPhotoUrl: string | null;
  body: string;
  /** Linked @handles in `body`. */
  mentions: MentionRef[];
  likeCount: number;
  /** Top-level comments only; always 0 on a reply, which cannot have replies. */
  replyCount: number;
  likedByMe: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Allowed, or the response to fail with. */
export type ShelfDecision =
  | { allowed: true }
  | { allowed: false; statusCode: number; code?: string; message: string };

// ── Decisions ─────────────────────────────────────────────────────────────────
//
// The shelf's state rules, as pure functions pinned by unit test. Each one is a
// rule a controller would otherwise re-derive slightly differently.

const ALLOW: ShelfDecision = { allowed: true };
const deny = (statusCode: number, message: string, code?: string): ShelfDecision => ({
  allowed: false,
  statusCode,
  message,
  ...(code && { code }),
});

/**
 * Whether `bookId` can become the group's current read.
 *
 * A second current book is refused rather than silently demoting the first:
 * the design has no "replace" screen, and quietly moving the current read back
 * to Want to Read would hide its live discussion from the group page without
 * the owner having asked for that. The owner finishes or removes it first.
 *
 * A book already on Want to Read or Finished is allowed — it moves (the second
 * is a re-read) — so the caller decides between INSERT and UPDATE on whether a
 * row exists, not here.
 */
export function decideSetCurrent(bookId: number, currentBookId: number | null): ShelfDecision {
  if (currentBookId === bookId) {
    return deny(409, 'That book is already the group’s current read', 'ALREADY_CURRENT');
  }
  if (currentBookId !== null) {
    return deny(
      409,
      'The group is already reading a book — mark it as finished or remove it first',
      'CURRENT_BOOK_EXISTS',
    );
  }
  return ALLOW;
}

/** Only the current read can be finished. */
export function decideFinish(
  status: GroupBookStatus,
  startedOn: string | null,
  finishedOn: string,
): ShelfDecision {
  if (status !== 'currently_reading') {
    return deny(409, 'Only the group’s current read can be marked as finished', 'NOT_CURRENT');
  }
  // ISO dates compare correctly as strings.
  if (startedOn !== null && finishedOn < startedOn) {
    return deny(400, 'The finish date cannot be before the start date');
  }
  return ALLOW;
}

/**
 * What "Edit book" may change, given which shelf the book is on.
 *
 * A Want to Read entry has no dates or note in the design — it is a list of
 * candidates — so there is nothing to edit there. A start date belongs to the
 * current and finished reads; a finish date only to finished ones. The merged
 * result has to keep finish on or after start, judged against whichever of the
 * two the request does not change.
 */
export function decideEdit(
  current: { status: GroupBookStatus; startedOn: string | null; finishedOn: string | null },
  patch: UpdateGroupBookInput,
): ShelfDecision {
  if (current.status === 'want_to_read') {
    return deny(409, 'Books on Want to Read have no dates or description to edit', 'NOT_EDITABLE');
  }
  if (patch.finishedOn !== undefined && current.status !== 'finished') {
    return deny(400, 'Only a finished book has a finish date');
  }
  const startedOn = patch.startedOn ?? current.startedOn;
  const finishedOn = patch.finishedOn ?? current.finishedOn;
  if (startedOn !== null && finishedOn !== null && finishedOn < startedOn) {
    return deny(400, 'The finish date cannot be before the start date');
  }
  return ALLOW;
}

/**
 * Whether a new comment may be posted on this shelf entry, optionally as a
 * reply to `parent`.
 *
 * Only the current read takes new comments — it is the only place the design
 * offers "Leave a comment". Threads on finished books stay readable but closed,
 * the way a book club's past meetings are a record rather than a live room.
 *
 * One level of replies: a reply must answer a top-level comment on the same
 * book. Replying to a reply would build a tree the screens cannot draw.
 */
export function decideComment(
  status: GroupBookStatus,
  groupBookId: number,
  parent: { groupBookId: number; parentId: number | null } | null | undefined,
): ShelfDecision {
  if (status !== 'currently_reading') {
    return deny(409, 'Comments are only open on the group’s current read', 'DISCUSSION_CLOSED');
  }
  if (parent === null) return deny(404, 'The comment you are replying to was not found');
  if (parent !== undefined) {
    if (parent.groupBookId !== groupBookId) {
      return deny(400, 'The comment you are replying to is on a different book');
    }
    if (parent.parentId !== null) {
      return deny(400, 'Replies cannot be replied to — reply to the original comment instead');
    }
  }
  return ALLOW;
}

/**
 * Whether the viewer may delete a comment.
 *
 * The owner may delete any comment — the owner is the only moderator a book
 * club has. The author may delete their own, but only while they can still see
 * the shelf: someone who left or was removed from a private group has lost
 * sight of its discussion, and reaching back into a room you can no longer see
 * to rewrite its record is not something the design offers. On a public group
 * everyone can see the shelf, so a former member can still take their words
 * back — the same line `unlikeComment` draws.
 *
 * Not seeing the shelf is a 403, as on every other read; seeing it but being
 * neither author nor owner is a 404, since deleting someone else's comment is
 * not a capability there is anything to explain about.
 */
export function decideDeleteComment(
  caps: Pick<ViewerCapabilities, 'canSeeShelf' | 'canManageShelf'>,
  isAuthor: boolean,
): ShelfDecision {
  if (caps.canManageShelf) return ALLOW;
  if (!caps.canSeeShelf) return deny(403, 'Only members can see a private group’s bookshelf');
  if (!isAuthor) return deny(404, 'Comment not found');
  return ALLOW;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(statusCode: number, message: string, code?: string): HttpError {
  return Object.assign(new Error(message), { statusCode, ...(code && { code }) });
}

function enforce(decision: ShelfDecision): void {
  if (!decision.allowed) throw fail(decision.statusCode, decision.message, decision.code);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/**
 * The viewer's capabilities for a group, in one round trip — the same shape
 * `groupsService.get` returns, so the screens and the routes judge alike.
 */
async function loadAccess(groupId: number, viewerId: number): Promise<ViewerCapabilities> {
  const [row] = await db
    .select({ ownerId: groups.ownerId, privacy: groups.privacy, status: groupMemberships.status })
    .from(groups)
    .leftJoin(
      groupMemberships,
      and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, viewerId)),
    )
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!row) throw fail(404, 'Group not found');
  return groupViewerCapabilities(row, row.status ?? null, viewerId);
}

// 403s, not 404s: a private group's existence is not secret (see the note on
// decideMembershipAction), so there is nothing to hide by pretending it is gone.
function requireSee(caps: ViewerCapabilities): void {
  if (!caps.canSeeShelf) throw fail(403, 'Only members can see a private group’s bookshelf');
}
function requireManage(caps: ViewerCapabilities): void {
  if (!caps.canManageShelf) throw fail(403, 'Only the group owner can change the bookshelf');
}
function requireComment(caps: ViewerCapabilities): void {
  if (!caps.canComment) throw fail(403, 'Only members can take part in this group’s discussion');
}

const shelfColumns = {
  id: groupBooks.id,
  bookId: groupBooks.bookId,
  status: groupBooks.status,
  description: groupBooks.description,
  startedOn: groupBooks.startedOn,
  finishedOn: groupBooks.finishedOn,
  addedAt: groupBooks.addedAt,
} as const;

type ShelfRow = {
  id: number;
  bookId: number;
  status: GroupBookStatus;
  description: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  addedAt: Date;
};

/**
 * Loads one shelf entry, scoped to the group in the URL. Scoping here is what
 * stops `/groups/1/books/<an entry of group 2>` from reaching another group.
 */
async function loadEntry(groupId: number, groupBookId: number): Promise<ShelfRow> {
  const [row] = await db
    .select(shelfColumns)
    .from(groupBooks)
    .where(and(eq(groupBooks.id, groupBookId), eq(groupBooks.groupId, groupId)))
    .limit(1);
  if (!row) throw fail(404, 'That book is not on this group’s shelf');
  return row;
}

/** Loads a comment, scoped through its book to the group in the URL. */
async function loadComment(
  groupId: number,
  commentId: number,
): Promise<{ id: number; groupBookId: number; parentId: number | null; userId: number; status: GroupBookStatus }> {
  const [row] = await db
    .select({
      id: groupBookComments.id,
      groupBookId: groupBookComments.groupBookId,
      parentId: groupBookComments.parentId,
      userId: groupBookComments.userId,
      status: groupBooks.status,
    })
    .from(groupBookComments)
    .innerJoin(groupBooks, eq(groupBooks.id, groupBookComments.groupBookId))
    .where(and(eq(groupBookComments.id, commentId), eq(groupBooks.groupId, groupId)))
    .limit(1);
  if (!row) throw fail(404, 'Comment not found');
  return row;
}

/**
 * Cover, title, authors and genre chips for a set of books, in three queries
 * regardless of how many. Authors are the A01 contributors; a book with none
 * falls back to whoever is listed first, so the row is never blank.
 */
async function loadBookCards(bookIds: number[]): Promise<Map<number, GroupBookCard>> {
  const cards = new Map<number, GroupBookCard>();
  if (bookIds.length === 0) return cards;
  const ids = [...new Set(bookIds)];

  const [bookRows, contributorRows, genreRows] = await Promise.all([
    db
      .select({
        id: books.id,
        isbn13: books.isbn13,
        title: books.title,
        subtitle: books.subtitle,
        coverUrl: books.coverUrl,
      })
      .from(books)
      .where(inArray(books.id, ids)),
    db
      .select({
        bookId: bookContributors.bookId,
        role: bookContributors.role,
        personName: bookContributors.personName,
      })
      .from(bookContributors)
      .where(inArray(bookContributors.bookId, ids))
      .orderBy(bookContributors.sequenceNumber),
    db
      .select({ bookId: bookGenres.bookId, name: genres.name, slug: genres.slug })
      .from(bookGenres)
      .innerJoin(genres, eq(genres.id, bookGenres.genreId))
      .where(inArray(bookGenres.bookId, ids))
      // Fixed order so duplicate display names keep the same slug (lib/genre-display).
      .orderBy(genres.id),
  ]);

  for (const b of bookRows) cards.set(b.id, { ...b, authors: [], genres: [] });

  const fallback = new Map<number, string>();
  for (const c of contributorRows) {
    if (!c.personName) continue;
    if (c.role === 'A01') cards.get(c.bookId)?.authors.push(c.personName);
    else if (!fallback.has(c.bookId)) fallback.set(c.bookId, c.personName);
  }
  for (const [bookId, name] of fallback) {
    const card = cards.get(bookId);
    if (card && card.authors.length === 0) card.authors.push(name);
  }
  for (const g of genreRows) {
    const card = cards.get(g.bookId);
    if (card) addDisplayGenre(card.genres, g);
  }

  return cards;
}

/** Total comments (replies included) per shelf entry. */
async function countComments(groupBookIds: number[]): Promise<Map<number, number>> {
  if (groupBookIds.length === 0) return new Map();
  const rows = await db
    .select({ groupBookId: groupBookComments.groupBookId, count: sql<number>`count(*)::int` })
    .from(groupBookComments)
    .where(inArray(groupBookComments.groupBookId, groupBookIds))
    .groupBy(groupBookComments.groupBookId);
  return new Map(rows.map((r) => [r.groupBookId, r.count]));
}

async function toItems(rows: ShelfRow[]): Promise<GroupShelfItem[]> {
  const [cards, counts, rendered] = await Promise.all([
    loadBookCards(rows.map((r) => r.bookId)),
    countComments(rows.map((r) => r.id)),
    renderTexts(rows.map((r) => r.description)),
  ]);
  // A row whose book vanished mid-request (the FK cascades) is dropped rather
  // than returned with a null book every client would have to guard against.
  return rows.flatMap((r, i) => {
    const book = cards.get(r.bookId);
    if (!book) return [];
    return [{
      id: r.id,
      status: r.status,
      book,
      description: rendered[i].text,
      descriptionMentions: rendered[i].mentions,
      startedOn: r.startedOn,
      finishedOn: r.finishedOn,
      addedAt: r.addedAt,
      commentCount: counts.get(r.id) ?? 0,
    }];
  });
}

/** Like counts, reply counts and the viewer's likes for a page of comments. */
async function enrichComments(
  rows: Omit<GroupCommentItem, 'likeCount' | 'replyCount' | 'likedByMe' | 'mentions'>[],
  viewerId: number,
): Promise<GroupCommentItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [likeCounts, replyCounts, mine, rendered] = await Promise.all([
    db
      .select({ commentId: groupBookCommentLikes.commentId, count: sql<number>`count(*)::int` })
      .from(groupBookCommentLikes)
      .where(inArray(groupBookCommentLikes.commentId, ids))
      .groupBy(groupBookCommentLikes.commentId),
    db
      .select({ parentId: groupBookComments.parentId, count: sql<number>`count(*)::int` })
      .from(groupBookComments)
      .where(inArray(groupBookComments.parentId, ids))
      .groupBy(groupBookComments.parentId),
    db
      .select({ commentId: groupBookCommentLikes.commentId })
      .from(groupBookCommentLikes)
      .where(and(inArray(groupBookCommentLikes.commentId, ids), eq(groupBookCommentLikes.userId, viewerId))),
    renderTexts(rows.map((r) => r.body)),
  ]);

  const likeMap = new Map(likeCounts.map((r) => [r.commentId, r.count]));
  const replyMap = new Map(replyCounts.map((r) => [r.parentId, r.count]));
  const liked = new Set(mine.map((r) => r.commentId));

  return rows.map((r, i) => ({
    ...r,
    body: rendered[i].text ?? '',
    mentions: rendered[i].mentions,
    likeCount: likeMap.get(r.id) ?? 0,
    replyCount: replyMap.get(r.id) ?? 0,
    likedByMe: liked.has(r.id),
  }));
}

const commentColumns = {
  id: groupBookComments.id,
  groupBookId: groupBookComments.groupBookId,
  parentId: groupBookComments.parentId,
  userId: groupBookComments.userId,
  userName: users.name,
  userUsername: users.username,
  userPhotoUrl: users.photoUrl,
  body: groupBookComments.body,
  createdAt: groupBookComments.createdAt,
  updatedAt: groupBookComments.updatedAt,
} as const;

// ── Service ───────────────────────────────────────────────────────────────────

export const groupBooksService = {
  /**
   * The shelf block on the group page: the current read and how many books are
   * on the other two shelves. The counts are what let the app choose between
   * the empty-state copy and a chevron row without a second request.
   *
   * Null when the viewer may not see the shelf, so "no shelf for you" and "an
   * empty shelf" are distinguishable.
   */
  async summary(groupId: number, caps: ViewerCapabilities): Promise<GroupShelfSummary | null> {
    if (!caps.canSeeShelf) return null;

    const [currentRows, counts] = await Promise.all([
      db
        .select(shelfColumns)
        .from(groupBooks)
        .where(and(eq(groupBooks.groupId, groupId), eq(groupBooks.status, 'currently_reading')))
        .limit(1),
      db
        .select({ status: groupBooks.status, count: sql<number>`count(*)::int` })
        .from(groupBooks)
        .where(eq(groupBooks.groupId, groupId))
        .groupBy(groupBooks.status),
    ]);

    const byStatus = new Map(counts.map((c) => [c.status, c.count]));
    const [current] = await toItems(currentRows);

    return {
      currentlyReading: current ?? null,
      wantToReadCount: byStatus.get('want_to_read') ?? 0,
      finishedCount: byStatus.get('finished') ?? 0,
    };
  },

  /** One shelf, paged. */
  async list(
    groupId: number,
    viewerId: number,
    opts: ListGroupBooksOptions,
  ): Promise<{ books: GroupShelfItem[]; total: number }> {
    requireSee(await loadAccess(groupId, viewerId));

    const where = and(eq(groupBooks.groupId, groupId), eq(groupBooks.status, opts.status));
    // "Date" is when it was finished on the Finished shelf, when it was added
    // everywhere else. id breaks ties so paging never repeats or skips a row
    // when two books share a day.
    const dateCol = opts.status === 'finished' ? groupBooks.finishedOn : groupBooks.addedAt;
    const orderBy =
      opts.sort === 'title_asc' ? [asc(books.title), asc(groupBooks.id)]
      : opts.sort === 'title_desc' ? [desc(books.title), desc(groupBooks.id)]
      : opts.sort === 'date_asc' ? [asc(dateCol), asc(groupBooks.id)]
      : [desc(dateCol), desc(groupBooks.id)];

    const [rows, [counted]] = await Promise.all([
      db
        .select(shelfColumns)
        .from(groupBooks)
        .innerJoin(books, eq(books.id, groupBooks.bookId))
        .where(where)
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groupBooks).where(where),
    ]);

    return { books: await toItems(rows), total: counted?.count ?? 0 };
  },

  /** One shelf entry — the Currently Reading screen. */
  async get(groupId: number, groupBookId: number, viewerId: number): Promise<GroupShelfItem> {
    requireSee(await loadAccess(groupId, viewerId));
    const [item] = await toItems([await loadEntry(groupId, groupBookId)]);
    if (!item) throw fail(404, 'That book is not on this group’s shelf');
    return item;
  },

  /**
   * Adds books to Want to Read.
   *
   * Partial success, like invitations: the picker can offer three books and one
   * may already be on the shelf, so each unusable id comes back in `skipped`
   * with a reason instead of failing the batch. ON CONFLICT DO NOTHING against
   * the (group, book) index is both the duplicate check and the race guard.
   */
  async addWantToRead(groupId: number, viewerId: number, bookIds: number[]): Promise<AddBooksResult> {
    requireManage(await loadAccess(groupId, viewerId));

    const requested = [...new Set(bookIds)];
    const skipped: AddBooksResult['skipped'] = [];

    const existing = await db
      .select({ id: books.id })
      .from(books)
      // A delisted title is gone from search and from saved books; it should not
      // be addable here either, even from a stale search result in the app.
      .where(and(inArray(books.id, requested), eq(books.isRemoved, false)));
    const found = new Set(existing.map((b) => b.id));
    const candidates = requested.filter((id) => {
      if (!found.has(id)) skipped.push({ bookId: id, reason: 'not_found' });
      return found.has(id);
    });
    if (candidates.length === 0) return { added: [], skipped };

    const added = await db
      .insert(groupBooks)
      .values(candidates.map((bookId) => ({ groupId, bookId, status: 'want_to_read' as const, addedBy: viewerId })))
      .onConflictDoNothing()
      .returning({ id: groupBooks.id, bookId: groupBooks.bookId });

    const addedIds = new Set(added.map((a) => a.bookId));
    const notAdded = candidates.filter((id) => !addedIds.has(id));
    if (notAdded.length > 0) {
      // Say which shelf it is already on, so the picker can explain itself.
      const onShelf = await db
        .select({ bookId: groupBooks.bookId, status: groupBooks.status })
        .from(groupBooks)
        .where(and(eq(groupBooks.groupId, groupId), inArray(groupBooks.bookId, notAdded)));
      const statusByBook = new Map(onShelf.map((r) => [r.bookId, r.status]));
      for (const bookId of notAdded) {
        skipped.push({ bookId, reason: 'already_on_shelf', status: statusByBook.get(bookId) });
      }
    }

    return { added, skipped };
  },

  /**
   * Makes a book the group's current read.
   *
   * A book already on Want to Read moves (keeping when it was added); one on
   * Finished is a re-read, so its old finish date is cleared. Anything else is
   * inserted. The partial unique index is the last word on "one current book":
   * a concurrent request that slips past the check below fails on it and gets
   * the same 409 the check would have given.
   */
  async setCurrent(groupId: number, viewerId: number, input: SetCurrentInput): Promise<GroupShelfItem> {
    requireManage(await loadAccess(groupId, viewerId));

    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, input.bookId), eq(books.isRemoved, false)))
      .limit(1);
    if (!book) throw fail(404, 'Book not found');

    const relevant = await db
      .select({ id: groupBooks.id, bookId: groupBooks.bookId, status: groupBooks.status })
      .from(groupBooks)
      .where(
        and(
          eq(groupBooks.groupId, groupId),
          or(eq(groupBooks.status, 'currently_reading'), eq(groupBooks.bookId, input.bookId)),
        ),
      );
    const current = relevant.find((r) => r.status === 'currently_reading');
    enforce(decideSetCurrent(input.bookId, current?.bookId ?? null));

    const existing = relevant.find((r) => r.bookId === input.bookId);
    const description = await mentionsService.prepare(input.description ?? null);
    const fields = {
      status: 'currently_reading' as const,
      startedOn: input.startedOn,
      finishedOn: null,
      description: description.text,
      updatedAt: new Date(),
    };

    let id: number;
    try {
      if (existing) {
        await db.update(groupBooks).set(fields).where(eq(groupBooks.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await db
          .insert(groupBooks)
          .values({ groupId, bookId: input.bookId, addedBy: viewerId, ...fields })
          .returning({ id: groupBooks.id });
        id = row.id;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw fail(
          409,
          'The group is already reading a book — mark it as finished or remove it first',
          'CURRENT_BOOK_EXISTS',
        );
      }
      throw err;
    }

    await mentionsService.afterWrite({ type: 'group_book', id }, viewerId, description.mentionedIds);
    return groupBooksService.get(groupId, id, viewerId);
  },

  /** "Edit book": the start date, the finish date or the description. */
  async update(
    groupId: number,
    groupBookId: number,
    viewerId: number,
    patch: UpdateGroupBookInput,
  ): Promise<GroupShelfItem> {
    requireManage(await loadAccess(groupId, viewerId));
    const entry = await loadEntry(groupId, groupBookId);
    enforce(decideEdit(entry, patch));

    const description = patch.description !== undefined ? await mentionsService.prepare(patch.description) : undefined;
    await db
      .update(groupBooks)
      .set({
        ...(patch.startedOn !== undefined && { startedOn: patch.startedOn }),
        ...(patch.finishedOn !== undefined && { finishedOn: patch.finishedOn }),
        ...(description !== undefined && { description: description.text }),
        updatedAt: new Date(),
      })
      .where(eq(groupBooks.id, groupBookId));

    if (description !== undefined) {
      await mentionsService.afterWrite({ type: 'group_book', id: groupBookId }, viewerId, description.mentionedIds);
    }

    return groupBooksService.get(groupId, groupBookId, viewerId);
  },

  /**
   * "Mark as Finished Reading". The status predicate on the UPDATE is the race
   * guard: if the book stopped being current in the meantime, nothing matches.
   */
  async finish(groupId: number, groupBookId: number, viewerId: number, finishedOn: string): Promise<GroupShelfItem> {
    requireManage(await loadAccess(groupId, viewerId));
    const entry = await loadEntry(groupId, groupBookId);
    enforce(decideFinish(entry.status, entry.startedOn, finishedOn));

    const updated = await db
      .update(groupBooks)
      .set({ status: 'finished', finishedOn, updatedAt: new Date() })
      .where(and(eq(groupBooks.id, groupBookId), eq(groupBooks.status, 'currently_reading')))
      .returning({ id: groupBooks.id });
    if (updated.length === 0) {
      throw fail(409, 'Only the group’s current read can be marked as finished', 'NOT_CURRENT');
    }

    return groupBooksService.get(groupId, groupBookId, viewerId);
  },

  /** Takes a book off the shelf. Its discussion goes with it (FK cascade). */
  async remove(groupId: number, groupBookId: number, viewerId: number): Promise<void> {
    requireManage(await loadAccess(groupId, viewerId));
    const deleted = await db
      .delete(groupBooks)
      .where(and(eq(groupBooks.id, groupBookId), eq(groupBooks.groupId, groupId)))
      .returning({ id: groupBooks.id });
    if (deleted.length === 0) throw fail(404, 'That book is not on this group’s shelf');
  },

  // ── Discussion ─────────────────────────────────────────────────────────────

  /** Top-level comments on a shelf entry, newest first. */
  async listComments(
    groupId: number,
    groupBookId: number,
    viewerId: number,
    limit: number,
    offset: number,
  ): Promise<{ comments: GroupCommentItem[]; total: number }> {
    requireSee(await loadAccess(groupId, viewerId));
    await loadEntry(groupId, groupBookId);

    const where = and(eq(groupBookComments.groupBookId, groupBookId), isNull(groupBookComments.parentId));
    const [rows, [counted]] = await Promise.all([
      db
        .select(commentColumns)
        .from(groupBookComments)
        .innerJoin(users, eq(users.id, groupBookComments.userId))
        .where(where)
        .orderBy(desc(groupBookComments.createdAt), desc(groupBookComments.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groupBookComments).where(where),
    ]);

    return { comments: await enrichComments(rows, viewerId), total: counted?.count ?? 0 };
  },

  /** Replies to one comment, oldest first so the thread reads as a conversation. */
  async listReplies(
    groupId: number,
    commentId: number,
    viewerId: number,
    limit: number,
    offset: number,
  ): Promise<{ comments: GroupCommentItem[]; total: number }> {
    requireSee(await loadAccess(groupId, viewerId));
    const parent = await loadComment(groupId, commentId);
    if (parent.parentId !== null) throw fail(400, 'Replies have no replies of their own');

    const where = eq(groupBookComments.parentId, commentId);
    const [rows, [counted]] = await Promise.all([
      db
        .select(commentColumns)
        .from(groupBookComments)
        .innerJoin(users, eq(users.id, groupBookComments.userId))
        .where(where)
        .orderBy(asc(groupBookComments.createdAt), asc(groupBookComments.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groupBookComments).where(where),
    ]);

    return { comments: await enrichComments(rows, viewerId), total: counted?.count ?? 0 };
  },

  async addComment(
    groupId: number,
    groupBookId: number,
    viewerId: number,
    body: string,
    parentId?: number,
  ): Promise<GroupCommentItem> {
    requireComment(await loadAccess(groupId, viewerId));
    const entry = await loadEntry(groupId, groupBookId);

    let parent: { groupBookId: number; parentId: number | null } | null | undefined;
    if (parentId !== undefined) {
      const [row] = await db
        .select({ groupBookId: groupBookComments.groupBookId, parentId: groupBookComments.parentId })
        .from(groupBookComments)
        .where(eq(groupBookComments.id, parentId))
        .limit(1);
      parent = row ?? null;
    }
    enforce(decideComment(entry.status, groupBookId, parent));

    const prepared = await mentionsService.prepare(body);
    const [row] = await db
      .insert(groupBookComments)
      .values({ groupBookId, userId: viewerId, parentId: parentId ?? null, body: prepared.text })
      .returning({ id: groupBookComments.id });

    await mentionsService.afterWrite({ type: 'group_comment', id: row.id }, viewerId, prepared.mentionedIds, { isNew: true });

    const [created] = await db
      .select(commentColumns)
      .from(groupBookComments)
      .innerJoin(users, eq(users.id, groupBookComments.userId))
      .where(eq(groupBookComments.id, row.id))
      .limit(1);
    const [rendered] = await renderTexts([created.body]);
    return { ...created, body: rendered.text ?? '', mentions: rendered.mentions, likeCount: 0, replyCount: 0, likedByMe: false };
  },

  /**
   * Edits your own comment. Still requires membership: someone removed from a
   * private group should not be able to keep rewriting what they left behind.
   */
  async updateComment(groupId: number, commentId: number, viewerId: number, body: string): Promise<void> {
    requireComment(await loadAccess(groupId, viewerId));
    const comment = await loadComment(groupId, commentId);
    // 404 for someone else's comment, as communityService does — editing is
    // not a capability anyone else has, so there is nothing to explain.
    if (comment.userId !== viewerId) throw fail(404, 'Comment not found');

    const prepared = await mentionsService.prepare(body);
    await db
      .update(groupBookComments)
      .set({ body: prepared.text, updatedAt: new Date() })
      .where(eq(groupBookComments.id, commentId));

    await mentionsService.afterWrite({ type: 'group_comment', id: commentId }, viewerId, prepared.mentionedIds);
  },

  /**
   * Deletes a comment and, if it is top-level, its replies. The group owner may
   * delete any comment. The author may delete their own only while they can
   * still see the shelf — so someone who left or was removed from a private
   * group gets a 403 here, as on every other read, while a former member of a
   * public group can still delete theirs. See `decideDeleteComment`.
   */
  async deleteComment(groupId: number, commentId: number, viewerId: number): Promise<void> {
    const caps = await loadAccess(groupId, viewerId);
    // Before the lookup, so a private ex-member learns nothing about which
    // comment ids exist — the same 403 they get everywhere else.
    requireSee(caps);
    const comment = await loadComment(groupId, commentId);
    enforce(decideDeleteComment(caps, comment.userId === viewerId));

    await db.delete(groupBookComments).where(eq(groupBookComments.id, commentId));
  },

  async likeComment(groupId: number, commentId: number, viewerId: number): Promise<void> {
    requireComment(await loadAccess(groupId, viewerId));
    await loadComment(groupId, commentId);
    await db.insert(groupBookCommentLikes).values({ userId: viewerId, commentId }).onConflictDoNothing();
  },

  /**
   * Removing your own like needs only sight of the shelf, not membership —
   * someone who left a public group can still take back a like.
   */
  async unlikeComment(groupId: number, commentId: number, viewerId: number): Promise<void> {
    requireSee(await loadAccess(groupId, viewerId));
    await loadComment(groupId, commentId);
    await db
      .delete(groupBookCommentLikes)
      .where(and(eq(groupBookCommentLikes.commentId, commentId), eq(groupBookCommentLikes.userId, viewerId)));
  },
};
