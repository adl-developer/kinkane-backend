import { pgTable, serial, varchar, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One web address someone has written into a post, comment, review, group text
 * or shelf note, and the short code it is shown as.
 *
 * The text itself stores `{{l:<id>}}` tokens (see lib/link-text.ts) that render
 * as `APP_URL/l/<code>`; tapping one goes through GET /l/:code, which counts
 * the click and sends the reader on to `url`. Going through our own address is
 * the point: a link found to be phishing or spam is switched off once, here,
 * and every post carrying it stops working at the same moment — nobody has to
 * find and edit the posts.
 *
 * ONE ROW PER ADDRESS, not per post. The same address posted twice gets the
 * same code, so blocking it covers every copy, and the click count is the
 * address's. `created_by` is whoever posted it first.
 */
export const shortLinks = pgTable(
  'short_links',
  {
    id: serial('id').primaryKey(),
    // Random, from lib/random-code — unguessable enough that links in private
    // posts cannot be found by walking codes.
    code: varchar('code', { length: 16 }).notNull(),
    // The normalised address (http or https only, at most 2048 characters).
    url: text('url').notNull(),
    // SET NULL: the address stays valid in every other post that carries it
    // after the first poster deletes their account.
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    clickCount: integer('click_count').notNull().default(0),
    // Set by an admin. A blocked link still renders, but the redirect shows a
    // "this link has been removed" page instead of forwarding.
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedReason: text('blocked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeUniq: uniqueIndex('idx_short_links_code').on(t.code),
    urlUniq: uniqueIndex('idx_short_links_url').on(t.url),
  }),
);

export type ShortLink = typeof shortLinks.$inferSelect;
export type NewShortLink = typeof shortLinks.$inferInsert;
