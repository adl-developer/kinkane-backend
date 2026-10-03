import { describe, it, expect } from 'vitest';
import {
  decideSetCurrent,
  decideFinish,
  decideEdit,
  decideComment,
  decideDeleteComment,
} from '../services/group-books.service';
import { groupViewerCapabilities } from '../services/groups.service';
import {
  isPlausibleReadingDate,
  setCurrentBookSchema,
  updateGroupBookSchema,
  createGroupCommentSchema,
  listGroupBooksSchema,
} from '../lib/group-book-input';
import type { GroupMembershipStatus } from '../db/schema';

// The group bookshelf's rules, pinned without a database. The end-to-end paths
// (the one-current-book index, cascades, cross-group ids) are exercised against
// a real Postgres separately; these are the decisions a controller would
// otherwise re-derive slightly differently.

const OWNER = 7;
const OTHER = 42;
const caps = (privacy: 'public' | 'private', status: GroupMembershipStatus | null, viewerId: number) =>
  groupViewerCapabilities({ ownerId: OWNER, privacy }, status, viewerId);

describe('shelf capabilities', () => {
  it('withholds a private group’s shelf exactly where it withholds the member list', () => {
    for (const privacy of ['public', 'private'] as const) {
      for (const status of [null, 'invited', 'requested', 'active'] as const) {
        const c = caps(privacy, status, OTHER);
        expect(c.canSeeShelf).toBe(c.canSeeMembers);
      }
    }
    expect(caps('private', 'invited', OTHER).canSeeShelf).toBe(false);
    expect(caps('public', null, OTHER).canSeeShelf).toBe(true);
  });

  it('lets only the owner manage the shelf', () => {
    expect(caps('public', null, OWNER).canManageShelf).toBe(true);
    expect(caps('public', 'active', OTHER).canManageShelf).toBe(false);
  });

  it('lets members comment but not passers-by or invitees', () => {
    expect(caps('public', 'active', OTHER).canComment).toBe(true);
    expect(caps('private', null, OWNER).canComment).toBe(true);
    expect(caps('public', null, OTHER).canComment).toBe(false);
    expect(caps('public', 'invited', OTHER).canComment).toBe(false);
  });
});

describe('decideSetCurrent', () => {
  it('allows a book when nothing is current', () => {
    expect(decideSetCurrent(10, null)).toEqual({ allowed: true });
  });

  it('refuses a second current book rather than demoting the first', () => {
    expect(decideSetCurrent(10, 11)).toMatchObject({ allowed: false, statusCode: 409, code: 'CURRENT_BOOK_EXISTS' });
  });

  it('says so when the book is already current', () => {
    expect(decideSetCurrent(10, 10)).toMatchObject({ allowed: false, statusCode: 409, code: 'ALREADY_CURRENT' });
  });
});

describe('decideFinish', () => {
  it('finishes the current read', () => {
    expect(decideFinish('currently_reading', '2026-09-20', '2026-09-24')).toEqual({ allowed: true });
    expect(decideFinish('currently_reading', '2026-09-20', '2026-09-20')).toEqual({ allowed: true });
  });

  it('refuses anything that is not current', () => {
    expect(decideFinish('want_to_read', null, '2026-09-24')).toMatchObject({ statusCode: 409, code: 'NOT_CURRENT' });
    expect(decideFinish('finished', '2026-09-01', '2026-09-24')).toMatchObject({ statusCode: 409 });
  });

  it('refuses a finish before the start', () => {
    expect(decideFinish('currently_reading', '2026-09-20', '2026-09-19')).toMatchObject({ statusCode: 400 });
  });
});

describe('decideEdit', () => {
  const current = { status: 'currently_reading' as const, startedOn: '2026-09-20', finishedOn: null };
  const finished = { status: 'finished' as const, startedOn: '2026-09-20', finishedOn: '2026-09-24' };

  it('has nothing to edit on Want to Read', () => {
    expect(decideEdit({ status: 'want_to_read', startedOn: null, finishedOn: null }, { description: 'x' }))
      .toMatchObject({ statusCode: 409, code: 'NOT_EDITABLE' });
  });

  it('only gives finished books a finish date', () => {
    expect(decideEdit(current, { finishedOn: '2026-09-25' })).toMatchObject({ statusCode: 400 });
    expect(decideEdit(finished, { finishedOn: '2026-09-25' })).toEqual({ allowed: true });
  });

  it('judges date order against the field the request leaves alone', () => {
    // Moving the start past the stored finish must fail even though the request
    // never mentions the finish date.
    expect(decideEdit(finished, { startedOn: '2026-09-25' })).toMatchObject({ statusCode: 400 });
    expect(decideEdit(finished, { finishedOn: '2026-09-19' })).toMatchObject({ statusCode: 400 });
    expect(decideEdit(current, { startedOn: '2026-09-25' })).toEqual({ allowed: true });
  });
});

describe('decideComment', () => {
  it('opens discussion only on the current read', () => {
    expect(decideComment('currently_reading', 1, undefined)).toEqual({ allowed: true });
    expect(decideComment('finished', 1, undefined)).toMatchObject({ statusCode: 409, code: 'DISCUSSION_CLOSED' });
    expect(decideComment('want_to_read', 1, undefined)).toMatchObject({ statusCode: 409 });
  });

  it('allows a reply to a top-level comment on the same book', () => {
    expect(decideComment('currently_reading', 1, { groupBookId: 1, parentId: null })).toEqual({ allowed: true });
  });

  it('refuses a reply to a reply — one level only', () => {
    expect(decideComment('currently_reading', 1, { groupBookId: 1, parentId: 5 })).toMatchObject({ statusCode: 400 });
  });

  it('refuses a reply to a comment on another book, and a missing parent', () => {
    expect(decideComment('currently_reading', 1, { groupBookId: 2, parentId: null })).toMatchObject({ statusCode: 400 });
    expect(decideComment('currently_reading', 1, null)).toMatchObject({ statusCode: 404 });
  });
});

describe('decideDeleteComment', () => {
  it('refuses an author who has left or been removed from a private group', () => {
    // Leaving deletes the membership row; removal does too — either way, no status.
    expect(decideDeleteComment(caps('private', null, OTHER), true)).toMatchObject({ statusCode: 403 });
    expect(decideDeleteComment(caps('private', 'invited', OTHER), true)).toMatchObject({ statusCode: 403 });
    expect(decideDeleteComment(caps('private', 'requested', OTHER), true)).toMatchObject({ statusCode: 403 });
  });

  it('still lets a former member of a public group delete their own comment', () => {
    expect(decideDeleteComment(caps('public', null, OTHER), true)).toEqual({ allowed: true });
  });

  it('lets a current member delete their own comment in either kind of group', () => {
    expect(decideDeleteComment(caps('private', 'active', OTHER), true)).toEqual({ allowed: true });
    expect(decideDeleteComment(caps('public', 'active', OTHER), true)).toEqual({ allowed: true });
  });

  it('lets the owner delete anyone’s comment', () => {
    expect(decideDeleteComment(caps('private', 'active', OWNER), false)).toEqual({ allowed: true });
    expect(decideDeleteComment(caps('public', null, OWNER), false)).toEqual({ allowed: true });
  });

  it('hides someone else’s comment from a non-owner who can see the shelf', () => {
    expect(decideDeleteComment(caps('private', 'active', OTHER), false)).toMatchObject({ statusCode: 404 });
    expect(decideDeleteComment(caps('public', null, OTHER), false)).toMatchObject({ statusCode: 404 });
  });
});

describe('isPlausibleReadingDate', () => {
  const now = new Date('2026-09-24T23:30:00Z');

  it('accepts today and tomorrow (UTC) so owners ahead of UTC can pick their own today', () => {
    expect(isPlausibleReadingDate('2026-09-24', now)).toBe(true);
    expect(isPlausibleReadingDate('2026-09-25', now)).toBe(true);
    expect(isPlausibleReadingDate('2020-01-01', now)).toBe(true);
  });

  it('refuses the day after tomorrow', () => {
    expect(isPlausibleReadingDate('2026-09-26', now)).toBe(false);
  });

  it('refuses dates that are not real days or not ISO', () => {
    expect(isPlausibleReadingDate('2026-02-30', now)).toBe(false);
    expect(isPlausibleReadingDate('2026-9-4', now)).toBe(false);
    expect(isPlausibleReadingDate('24/09/2026', now)).toBe(false);
    expect(isPlausibleReadingDate('2026-09-24T00:00:00Z', now)).toBe(false);
  });
});

describe('request shapes', () => {
  it('requires a book and a start date to set the current read', () => {
    expect(setCurrentBookSchema.safeParse({ bookId: 1, startedOn: '2026-09-20' }).success).toBe(true);
    expect(setCurrentBookSchema.safeParse({ bookId: 1 }).success).toBe(false);
  });

  it('refuses an empty edit', () => {
    expect(updateGroupBookSchema.safeParse({}).success).toBe(false);
    expect(updateGroupBookSchema.safeParse({ description: null }).success).toBe(true);
  });

  it('refuses a comment of only whitespace', () => {
    expect(createGroupCommentSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(createGroupCommentSchema.safeParse({ body: ' hi ' })).toMatchObject({ success: true, data: { body: 'hi' } });
  });

  it('requires a shelf and defaults the sort', () => {
    expect(listGroupBooksSchema.safeParse({}).success).toBe(false);
    expect(listGroupBooksSchema.parse({ status: 'finished' })).toMatchObject({ sort: 'date_desc', limit: 20, offset: 0 });
  });
});
