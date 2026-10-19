import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { restockRequests } from '../../db/schema';
import { likeContains } from '../../lib/escape-like';
import { shortFormat } from '../restock-requests.service';

export type RestockStatusFilter = 'pending' | 'fulfilled';

export interface RestockListQuery {
  status?: RestockStatusFilter;
  q?: string;
  limit: number;
  offset: number;
}

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * The search box: "Title, author, or customer…" in the design, plus ISBN, which
 * is what an admin has in hand after a call with Gardners.
 *
 * Written against the aliases `rr` and `b` used by every query below, rather
 * than through Drizzle's column objects. In a select with no joins Drizzle
 * prints a column as a bare "id", which inside a correlated subquery binds to
 * the subquery's own table and silently matches the wrong rows.
 */
function searchCondition(q: string): SQL {
  const like = likeContains(q);
  return sql`(
    b.title ILIKE ${like}
    OR b.isbn13 ILIKE ${like}
    OR rr.isbn13 ILIKE ${like}
    OR rr.name ILIKE ${like}
    OR rr.email ILIKE ${like}
    OR EXISTS (
      SELECT 1 FROM book_contributors bc
      WHERE bc.book_id = rr.book_id AND bc.person_name ILIKE ${like}
    )
  )`;
}

function whereFor(query: { status?: RestockStatusFilter; q?: string }): SQL {
  const parts: SQL[] = [sql`true`];
  if (query.status) parts.push(sql`rr.status = ${query.status}`);
  if (query.q) parts.push(searchCondition(query.q));
  return sql.join(parts, sql` AND `);
}

interface RequestRow extends Record<string, unknown> {
  id: number;
  reference: string | null;
  book_id: number;
  isbn13: string;
  user_id: number | null;
  name: string | null;
  email: string | null;
  status: RestockStatusFilter;
  created_at: Date | string;
  fulfilled_at: Date | string | null;
}

interface BookRow extends Record<string, unknown> {
  id: number;
  title: string;
  isbn13: string | null;
  cover_url: string | null;
  product_form: string | null;
  author: string | null;
}

/** postgres.js hands back timestamps from raw SQL as strings or Dates by path. */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function requestOut(r: RequestRow) {
  return {
    id: r.id,
    reference: r.reference,
    // Null when the customer left none. The design renders a null name as
    // "Anonymous" and a null email as "No contact details provided".
    name: r.name,
    email: r.email,
    anonymous: r.name === null,
    userId: r.user_id,
    status: r.status,
    requestedAt: toDate(r.created_at) as Date,
    fulfilledAt: toDate(r.fulfilled_at),
  };
}

async function booksById(ids: number[]): Promise<Map<number, BookRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<BookRow>(sql`
    SELECT b.id, b.title, b.isbn13, b.cover_url, b.product_form,
      (SELECT bc.person_name FROM book_contributors bc
        WHERE bc.book_id = b.id
        ORDER BY bc.sequence_number NULLS LAST, bc.id
        LIMIT 1) AS author
    FROM books b
    WHERE b.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  return new Map([...rows].map((r) => [r.id, r]));
}

export const adminRestockRequestsService = {
  /**
   * The Restock Requests screen: one card per edition, newest request first.
   *
   * **Paged by card, not by request.** A card is the unit on screen, and paging
   * by request would split one book's requests across two pages, showing the
   * same card twice with a different count on each.
   *
   * A card is ordered by its newest request *in the current filter*, and lists
   * only the requests that match it, newest first: on the Fulfilled tab a card
   * shows its fulfilled requests and counts only those.
   *
   * `counts` drives the three counters and the tab labels. They follow the
   * search box but not the tab, so "Pending (5)" still says 5 while the
   * Fulfilled tab is open. They count requests, not books, as the design does.
   */
  async list(query: RestockListQuery) {
    const where = whereFor(query);
    const countsWhere = whereFor({ q: query.q });

    const [cardRows, [totals], countRows] = await Promise.all([
      db.execute<{ book_id: number; request_count: number }>(sql`
        SELECT rr.book_id, count(*)::int AS request_count
        FROM restock_requests rr
        JOIN books b ON b.id = rr.book_id
        WHERE ${where}
        GROUP BY rr.book_id
        ORDER BY max(rr.created_at) DESC, rr.book_id DESC
        LIMIT ${query.limit} OFFSET ${query.offset}
      `),
      db.execute<{ requests: number; cards: number }>(sql`
        SELECT count(*)::int AS requests, count(DISTINCT rr.book_id)::int AS cards
        FROM restock_requests rr
        JOIN books b ON b.id = rr.book_id
        WHERE ${where}
      `),
      db.execute<{ status: RestockStatusFilter; n: number }>(sql`
        SELECT rr.status, count(*)::int AS n
        FROM restock_requests rr
        JOIN books b ON b.id = rr.book_id
        WHERE ${countsWhere}
        GROUP BY rr.status
      `),
    ]);

    const bookIds = [...cardRows].map((c) => c.book_id);
    const [bookMap, requestRows] = await Promise.all([
      booksById(bookIds),
      bookIds.length
        ? db.execute<RequestRow>(sql`
            SELECT rr.id, rr.reference, rr.book_id, rr.isbn13, rr.user_id, rr.name, rr.email,
              rr.status, rr.created_at, rr.fulfilled_at
            FROM restock_requests rr
            JOIN books b ON b.id = rr.book_id
            WHERE ${where}
              AND rr.book_id IN (${sql.join(bookIds.map((id) => sql`${id}`), sql`, `)})
            ORDER BY rr.created_at DESC, rr.id DESC
          `)
        : Promise.resolve([] as RequestRow[]),
    ]);

    const requestsByBook = new Map<number, ReturnType<typeof requestOut>[]>();
    for (const r of requestRows) {
      const list = requestsByBook.get(r.book_id) ?? [];
      list.push(requestOut(r));
      requestsByBook.set(r.book_id, list);
    }

    const counts = { total: 0, pending: 0, fulfilled: 0 };
    for (const c of countRows) {
      counts[c.status] = c.n;
      counts.total += c.n;
    }

    return {
      cards: [...cardRows].map((c) => {
        const book = bookMap.get(c.book_id);
        const requests = requestsByBook.get(c.book_id) ?? [];
        return {
          book: {
            id: c.book_id,
            title: book?.title ?? '',
            author: book?.author ?? null,
            isbn13: book?.isbn13 ?? null,
            coverUrl: book?.cover_url ?? null,
            format: shortFormat(book?.product_form ?? null),
          },
          requestCount: c.request_count,
          pendingCount: requests.filter((r) => r.status === 'pending').length,
          requests,
        };
      }),
      // Requests matching the tab and search — the "6 requests" beside the tabs.
      totalRequests: totals.requests,
      // Cards matching, for paging.
      totalCards: totals.cards,
      counts,
    };
  },

  /**
   * Every request matching the tab and search, one CSV row each, newest first.
   * Flat rather than by card: a spreadsheet wants one row per thing.
   */
  async exportRows(query: { status?: RestockStatusFilter; q?: string }, cap: number) {
    const where = whereFor(query);
    const [rows, [total]] = await Promise.all([
      db.execute<RequestRow & { title: string; author: string | null; product_form: string | null }>(sql`
        SELECT rr.id, rr.reference, rr.book_id, rr.isbn13, rr.user_id, rr.name, rr.email,
          rr.status, rr.created_at, rr.fulfilled_at, b.title, b.product_form,
          (SELECT bc.person_name FROM book_contributors bc
            WHERE bc.book_id = rr.book_id
            ORDER BY bc.sequence_number NULLS LAST, bc.id
            LIMIT 1) AS author
        FROM restock_requests rr
        JOIN books b ON b.id = rr.book_id
        WHERE ${where}
        ORDER BY rr.created_at DESC, rr.id DESC
        LIMIT ${cap}
      `),
      db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM restock_requests rr
        JOIN books b ON b.id = rr.book_id
        WHERE ${where}
      `),
    ]);

    return {
      rows: [...rows].map((r) => ({
        ...requestOut(r),
        isbn13: r.isbn13,
        title: r.title,
        author: r.author,
        format: shortFormat(r.product_form),
      })),
      total: total.n,
    };
  },

  /**
   * "Mark fulfilled" on one person's request. Idempotent: fulfilling a
   * fulfilled request keeps its original time and admin, so a double click does
   * not rewrite who dealt with it.
   */
  async fulfil(id: number, adminId: number) {
    const [updated] = await db
      .update(restockRequests)
      .set({ status: 'fulfilled', fulfilledAt: new Date(), fulfilledBy: adminId })
      .where(and(eq(restockRequests.id, id), eq(restockRequests.status, 'pending')))
      .returning({ id: restockRequests.id, status: restockRequests.status, fulfilledAt: restockRequests.fulfilledAt });
    if (updated) return updated;
    return this.current(id);
  },

  /** Undo: back to pending, forgetting who fulfilled it and when. */
  async reopen(id: number) {
    const [updated] = await db
      .update(restockRequests)
      .set({ status: 'pending', fulfilledAt: null, fulfilledBy: null })
      .where(eq(restockRequests.id, id))
      .returning({ id: restockRequests.id, status: restockRequests.status, fulfilledAt: restockRequests.fulfilledAt });
    if (!updated) throw httpError('Restock request not found', 404);
    return updated;
  },

  /**
   * "Fulfil all" on a card: every pending request for that edition. One
   * restock at Gardners answers all of them. Returns the ids it changed, so the
   * console can undo them one by one if it was a mistake.
   */
  async fulfilAllForBook(bookId: number, adminId: number) {
    const updated = await db
      .update(restockRequests)
      .set({ status: 'fulfilled', fulfilledAt: new Date(), fulfilledBy: adminId })
      .where(and(eq(restockRequests.bookId, bookId), eq(restockRequests.status, 'pending')))
      .returning({ id: restockRequests.id });
    return { bookId, fulfilledIds: updated.map((u) => u.id) };
  },

  async current(id: number) {
    const [row] = await db
      .select({ id: restockRequests.id, status: restockRequests.status, fulfilledAt: restockRequests.fulfilledAt })
      .from(restockRequests)
      .where(eq(restockRequests.id, id))
      .limit(1);
    if (!row) throw httpError('Restock request not found', 404);
    return row;
  },
};
