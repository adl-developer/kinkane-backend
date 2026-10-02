import { z } from 'zod';

/**
 * Request shapes for a group's bookshelf and its discussion.
 *
 * Kept out of the controller for the same reason as `group-input.ts`: the
 * controller's import graph initialises Firebase, and a unit test should not
 * need credentials to check a date rule.
 */

/**
 * Whether `value` is a real calendar day no later than tomorrow (UTC).
 *
 * Tomorrow rather than today because "today" depends on where the owner is: at
 * 01:00 in Lagos on the 25th it is still the 24th in UTC, and refusing the date
 * on their own calendar would read as a bug. Anything further out is a typo or a
 * scheduled read, and the design offers neither.
 *
 * `now` is a parameter so the boundary can be tested without faking the clock.
 */
export function isPlausibleReadingDate(value: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Date rolls 2026-02-30 over to March 2nd rather than failing, so round-trip
  // it: a date that does not survive is not a real day.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return parsed.getTime() <= tomorrow;
}

export const readingDateSchema = z
  .string()
  .refine((v) => isPlausibleReadingDate(v), {
    message: 'Must be a real date in YYYY-MM-DD form, not in the future',
  });

const descriptionSchema = z.string().trim().max(2000);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// The same four values as GET /user-books, since no sort sheet is designed and
// the personal shelf is the one readers already know. "date" means when a book
// was added on Want to Read and when it was finished on Finished.
export const listGroupBooksSchema = paginationSchema.extend({
  status: z.enum(['want_to_read', 'currently_reading', 'finished']),
  sort: z.enum(['title_asc', 'title_desc', 'date_asc', 'date_desc']).default('date_desc'),
});

// Capped at 50 like invitations — the picker's multi-select ("Add 2 books").
export const addGroupBooksSchema = z.object({
  bookIds: z.array(z.number().int().positive()).min(1).max(50),
});

export const setCurrentBookSchema = z.object({
  bookId: z.number().int().positive(),
  startedOn: readingDateSchema,
  description: descriptionSchema.nullable().optional(),
});

export const updateGroupBookSchema = z
  .object({
    startedOn: readingDateSchema.optional(),
    finishedOn: readingDateSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one of startedOn, finishedOn or description must be provided',
  });

export const finishGroupBookSchema = z.object({
  finishedOn: readingDateSchema,
});

// Same bounds as community comments. `.trim()` before `.min(1)` so a comment of
// only spaces is refused — see the note on groupNameSchema.
export const groupCommentBodySchema = z.string().trim().min(1).max(2000);

export const createGroupCommentSchema = z.object({
  body: groupCommentBodySchema,
  parentId: z.number().int().positive().optional(),
});

export const updateGroupCommentSchema = z.object({
  body: groupCommentBodySchema,
});

export const groupCommentPageSchema = paginationSchema;
