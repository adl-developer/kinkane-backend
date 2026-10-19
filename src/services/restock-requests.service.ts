import { eq } from 'drizzle-orm';
import { db } from '../db';
import { books, restockRequests, users } from '../db/schema';
import { availabilityService } from './commerce/availability.service';
import { adminNotificationsService } from './admin/notifications.service';
import { getProductFormLabel } from '../lib/product-form';

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

export const restockRequestsService = {
  /**
   * Records a "Request Restock" press.
   *
   * **Only for an edition that is out of stock.** The book page shows the button
   * beside a greyed-out "Out of Stock", and the server holds the same line so a
   * stale page cannot file a request for something buyable:
   *
   *   - out of stock, or unsuppliable for now (reprinting, out of stock
   *     indefinitely) → accepted. Both render as "Out of Stock" in the shop, and
   *     both are something only a conversation with Gardners can change.
   *   - supplied to order (extended catalogue, print on demand) → refused with
   *     IN_STOCK. The client decided these stay buyable with no button: the
   *     customer can simply order one.
   *   - market-restricted in the customer's country → refused. Restocking would
   *     not let them buy it. Only checked when the country is known; an unknown
   *     country is not a reason to turn a customer away from a request.
   *   - no price, withdrawn, or no such book → the book is not on sale at all.
   *
   * Not de-duplicated, on purpose — see the table.
   *
   * The bell entry is written after the row and never fails the request. The
   * admin email is a later phase; `admin_emailed_at` stays null until then.
   */
  async submit(input: RestockSubmission): Promise<{ reference: string }> {
    const availability = await availabilityService.check([input.bookId], input.country ?? '');
    const reason = availability.rejected.get(input.bookId);

    if (availability.buyable.has(input.bookId)) {
      throw httpError('This book can be ordered now, so there is nothing to restock', 409, 'IN_STOCK');
    }
    if (reason === 'not_found') throw httpError('Book not found', 404, 'BOOK_NOT_FOUND');
    if (reason === 'no_price') {
      throw httpError('This book is not currently for sale', 409, 'NOT_FOR_SALE');
    }
    // check() only reaches market restrictions for books that are otherwise
    // buyable, so an in-stock restricted title lands here.
    if (reason === 'market_restricted') {
      throw httpError('This book cannot be sold in your country', 409, 'MARKET_RESTRICTED');
    }

    const [book] = await db
      .select({ isbn13: books.isbn13, title: books.title, productForm: books.productForm })
      .from(books)
      .where(eq(books.id, input.bookId))
      .limit(1);
    // check() said not_found for anything without an ISBN, so this is present.
    const isbn13 = book.isbn13 as string;

    if (input.country && (await availabilityService.isRestrictedIn(isbn13, input.country))) {
      throw httpError('This book cannot be sold in your country', 409, 'MARKET_RESTRICTED');
    }

    const contact = await contactFor(input);

    const [row] = await db
      .insert(restockRequests)
      .values({ bookId: input.bookId, isbn13, userId: input.userId, ...contact })
      .returning({ id: restockRequests.id });

    const reference = restockReference(row.id);
    await db.update(restockRequests).set({ reference }).where(eq(restockRequests.id, row.id));

    const format = shortFormat(book.productForm);
    await adminNotificationsService.emit({
      type: 'restock_requested',
      title: 'New restock request',
      body: `${contact.name ?? 'Someone'} asked for ${book.title}${format ? ` (${format})` : ''} to be restocked.`,
      userId: input.userId ?? undefined,
    });

    return { reference };
  },
};

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
