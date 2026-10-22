import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { books, gardnersMarketRestrictions, gardnersStock, restockRequests, users } from '../db/schema';
import { isRestricted } from './commerce/availability.service';
import { gardnersRegionsForCountry } from './commerce/gardners-regions';
import { adminNotificationsService } from './admin/notifications.service';
import { getProductFormLabel } from '../lib/product-form';
import { sendRestockRequestAdminEmail, sendRestockRequestCustomerEmail } from '../emails';
import type { RestockEmailBook } from '../emails/transactional/restock-request';
import { logger } from '../lib/logger';
import { config } from '../config';
import { UNSUPPLIABLE_REPORT_CODE_SET, isSupplyToOrder } from '../lib/shoppable';

export interface RestockSubmission {
  bookId: number;
  /** Null for a request with no session at all (the mobile app, signed out). */
  userId: number | null;
  name: string | null;
  email: string | null;
  /** The customer's country from the request, or null when it cannot be told. */
  country: string | null;
}

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * "RR001". Padded to three like report references, and simply longer past 999.
 * Exported for the tests.
 */
export function restockReference(id: number): string {
  return `RR${String(id).padStart(3, '0')}`;
}

/**
 * The unsuppliable report codes a restock can still answer: reprinting (R/P)
 * and out of stock indefinitely (OSI). Gardners will have copies again, so a
 * call is worth making.
 *
 * The rest of UNSUPPLIABLE_REPORT_CODES are refused: out of print and cancelled
 * books will never come back, and not-yet-published, postponed and
 * refer-to-publisher titles are not out of stock, they are not out at all. A
 * request for one would sit in the admin's Pending list with nothing anyone can
 * do about it.
 */
export const RESTOCKABLE_REPORT_CODES: ReadonlySet<string> = new Set(['R/P', 'RP', 'OSI']);

export type RestockRefusal = 'BOOK_NOT_FOUND' | 'NOT_FOR_SALE' | 'UNAVAILABLE' | 'MARKET_RESTRICTED' | 'IN_STOCK';

/**
 * Whether an edition can take a restock request, and if not, why. Pure, so the
 * rules are pinned by unit tests; `restricted` is null when the customer's
 * country cannot be judged.
 *
 * Mirrors the add-to-cart gate (availabilityService.check) in what it means by
 * a price and by supply-to-order, but asks the opposite question.
 */
export function restockEligibility(
  book: { isRemoved: boolean; isbn13: string | null; rrpGbp: string | null; stockQty: number | null; reportCode: string | null } | undefined,
  restricted: boolean | null,
): RestockRefusal | null {
  if (!book || book.isRemoved || !book.isbn13) return 'BOOK_NOT_FOUND';

  const rrp = book.rrpGbp === null ? NaN : Number(book.rrpGbp);
  if (!Number.isFinite(rrp) || rrp <= 0) return 'NOT_FOR_SALE';

  const reportCode = book.reportCode?.trim().toUpperCase() ?? '';
  const unsuppliable = UNSUPPLIABLE_REPORT_CODE_SET.has(reportCode);
  if (unsuppliable && !RESTOCKABLE_REPORT_CODES.has(reportCode)) return 'UNAVAILABLE';

  // Before the stock test: a restricted customer cannot buy an in-stock copy
  // either, and "it can be ordered now" would be untrue for them.
  if (restricted) return 'MARKET_RESTRICTED';

  if (!unsuppliable && (isSupplyToOrder(book.reportCode) || (book.stockQty ?? 0) > 0)) return 'IN_STOCK';

  return null;
}

const REFUSALS: Record<RestockRefusal, { statusCode: number; message: string }> = {
  BOOK_NOT_FOUND: { statusCode: 404, message: 'Book not found' },
  NOT_FOR_SALE: { statusCode: 409, message: 'This book is not currently for sale' },
  UNAVAILABLE: { statusCode: 409, message: 'This book cannot be restocked' },
  MARKET_RESTRICTED: { statusCode: 409, message: 'This book cannot be sold in your country' },
  IN_STOCK: { statusCode: 409, message: 'This book can be ordered now, so there is nothing to restock' },
};

export const restockRequestsService = {
  /**
   * Records a "Request Restock" press.
   *
   * **Only for an edition that is out of stock.** The book page shows the button
   * beside a greyed-out "Out of Stock", and the server holds the same line so a
   * stale page cannot file a request for something that can be bought, or that
   * no restock will ever bring back. See restockEligibility for the rules.
   *
   * Rights are judged only when the customer's country is known *and* mapped to
   * Gardners regions. Add-to-cart blocks a restricted title for an unmapped
   * country, because it is about to sell one; here nothing is being sold, and
   * the client's rule is that not knowing where someone is never turns them away.
   *
   * Not de-duplicated, on purpose — see the table.
   *
   * The row and its reference are written in one transaction, so a request
   * never exists without its RR number. The bell entry and the two emails
   * follow, and none of them can fail the request: from the customer's side it
   * was sent, and it was — the row exists.
   */
  async submit(input: RestockSubmission): Promise<{ reference: string }> {
    // The edition and its stock in one query, its restriction rows alongside.
    // The ISBN is looked up inside the second query so the two can run together.
    const [[book], restrictionRows] = await Promise.all([
      db
        .select({
          title: books.title,
          isbn13: books.isbn13,
          productForm: books.productForm,
          coverUrl: books.coverUrl,
          // The primary author, for the emails. Aliased explicitly: a bare
          // column here would print as "id" and bind to book_contributors.
          author: sql<string | null>`(
            SELECT bc.person_name FROM book_contributors bc
            WHERE bc.book_id = ${input.bookId}
            ORDER BY bc.sequence_number NULLS LAST, bc.id
            LIMIT 1
          )`,
          isRemoved: books.isRemoved,
          rrpGbp: gardnersStock.rrpGbp,
          stockQty: gardnersStock.stockQty,
          reportCode: gardnersStock.reportCode,
        })
        .from(books)
        // On isbn13, as add-to-cart joins it: gardners_stock.book_id is backfilled late.
        .leftJoin(gardnersStock, eq(gardnersStock.isbn13, books.isbn13))
        .where(eq(books.id, input.bookId))
        .limit(1),
      db
        .select({ flag: gardnersMarketRestrictions.flag, regionCode: gardnersMarketRestrictions.regionCode })
        .from(gardnersMarketRestrictions)
        .where(sql`${gardnersMarketRestrictions.isbn13} = (SELECT b.isbn13 FROM books b WHERE b.id = ${input.bookId})`),
    ]);

    const judgeable = input.country !== null && gardnersRegionsForCountry(input.country).length > 0;
    const restricted =
      judgeable && book?.isbn13 ? isRestricted(restrictionRows, input.country as string, book.isbn13) : null;

    const refusal = restockEligibility(book, restricted);
    if (refusal) throw httpError(REFUSALS[refusal].message, REFUSALS[refusal].statusCode, refusal);

    const isbn13 = book.isbn13 as string;
    const contact = await contactFor(input);

    const reference = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(restockRequests)
        .values({ bookId: input.bookId, isbn13, userId: input.userId, ...contact })
        .returning({ id: restockRequests.id });
      const ref = restockReference(row.id);
      await tx.update(restockRequests).set({ reference: ref }).where(eq(restockRequests.id, row.id));
      return ref;
    });

    // No customer-typed text in the bell. This endpoint is public, so a name
    // here would let anyone write whatever they like into the staff feed; the
    // name is on the Restock Requests screen, one click away.
    const format = shortFormat(book.productForm);
    await adminNotificationsService.emit({
      type: 'restock_requested',
      title: 'New restock request',
      body: `A customer asked for ${book.title}${format ? ` (${format})` : ''} to be restocked.`,
      userId: input.userId ?? undefined,
    });

    const emailBook: RestockEmailBook = {
      title: book.title,
      author: book.author,
      format,
      coverUrl: book.coverUrl,
      url: `${config.appUrl}/books/${input.bookId}`,
    };
    await sendRestockEmails(reference, contact, emailBook);

    return { reference };
  },
};

/** At most this many confirmation emails a day to one address. See sendRestockEmails. */
export const CUSTOMER_EMAILS_PER_DAY = 3;

/**
 * The staff email and, when there is an address to send it to, the customer's.
 *
 * Both are attempted together, and a failure is logged rather than thrown. The
 * staff email stamps `admin_emailed_at` when it actually goes out, so a null
 * there marks a request somebody has to notice another way — the bell and the
 * console list still have it.
 *
 * **The customer email is capped per address.** The form is public and takes
 * any address, so without a cap it would let anyone use our sender to mail a
 * stranger, twenty times an hour per IP. The request is always stored; only the
 * email is skipped once an address has had CUSTOMER_EMAILS_PER_DAY today. The
 * count is of requests carrying that address in the last 24 hours, this one
 * included, so it needs no extra column.
 */
async function sendRestockEmails(
  reference: string,
  contact: { name: string | null; email: string | null },
  book: RestockEmailBook,
): Promise<void> {
  const customerEmail = contact.email ? await customerEmailAllowed(contact.email) : false;

  const [admin, customer] = await Promise.allSettled([
    sendRestockRequestAdminEmail({ reference, name: contact.name, email: contact.email, book }),
    customerEmail ? sendRestockRequestCustomerEmail(contact.email as string, contact.name, book) : Promise.resolve(),
  ]);

  if (admin.status === 'fulfilled') {
    await db
      .update(restockRequests)
      .set({ adminEmailedAt: new Date() })
      .where(eq(restockRequests.reference, reference))
      .catch((err: Error) => logger.error('Restock email sent but not recorded', { reference, error: err.message }));
  } else {
    logger.error('Restock request stored but the admin email failed', {
      reference,
      error: (admin.reason as Error).message,
    });
  }

  if (customer.status === 'rejected') {
    logger.error('Restock request stored but the customer email failed', {
      reference,
      error: (customer.reason as Error).message,
    });
  }
}

async function customerEmailAllowed(email: string): Promise<boolean> {
  // The window is the database's clock, the same one that stamped created_at,
  // so a server whose clock differs from the database's cannot widen or close it.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(restockRequests)
    .where(
      and(
        sql`lower(${restockRequests.email}) = lower(${email})`,
        gte(restockRequests.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return Number(row.n) <= CUSTOMER_EMAILS_PER_DAY;
}

/**
 * The name and email to file the request under.
 *
 * What the form sent wins. Otherwise a signed-in customer's account details are
 * used, so they never have to fill in the form — **except** for the web shop's
 * silent guest accounts, which are named "Guest" with a made-up address. Copying
 * those would show the admin a contact that cannot be contacted.
 */
async function contactFor(input: RestockSubmission): Promise<{ name: string | null; email: string | null }> {
  if (input.userId === null) return { name: input.name, email: input.email };

  const [account] = await db
    .select({ name: users.name, email: users.email, isGuest: users.isGuest })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!account || account.isGuest) return { name: input.name, email: input.email };

  return {
    name: input.name ?? account.name.slice(0, 200),
    email: input.email ?? (account.email.length <= 254 ? account.email : null),
  };
}

/**
 * "Paperback", "Hardcover" — the badge on a console card. The full ONIX label
 * ("Paperback or softback book") for anything else, and null when unknown.
 * Exported for the admin service and the tests.
 */
export function shortFormat(productForm: string | null): string | null {
  if (productForm === 'BC') return 'Paperback';
  if (productForm === 'BB') return 'Hardcover';
  return getProductFormLabel(productForm);
}
