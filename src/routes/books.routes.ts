import { Router } from 'express';
import { booksController } from '../controllers/books.controller';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /books/search?q=harr&limit=8&type=all|title|author&dedupe=false
 * Typeahead suggestions — returns up to 15 ranked matches as the user types.
 * `q` matches the book's title and its author's name by default (`type=all`),
 * so typing an author returns that author's books; pass `type=title` or
 * `type=author` to match only one side. Always returns books, ranked by:
 * prefix match > word prefix > trigram similarity > full-text search fallback.
 * Title matches lead, but author matches keep a reserved share of the list so
 * they can't be crowded out by a query that also happens to match titles.
 * Minimum 1 character. `dedupe=true` collapses same-titled editions down to
 * the best one (see booksService.suggestions) — off by default so every
 * edition stays visible; pass it from clients (e.g. mobile) that want one
 * result per title. Public — no auth required.
 *
 * NOTE: must be defined before /:id so Express does not treat "search" as an ID.
 */
router.get('/search', booksController.suggestions);

/**
 * GET /books/recommendations?bookIds=1,2,3&limit=8
 *
 * "You may also like" for a whole basket — the cart page's carousel. Averages
 * the basket's embeddings and returns the nearest titles to that centre, which
 * is why it is not the per-book endpoint run several times and merged: a basket
 * of one cookbook and two thrillers should suggest something for the shopper,
 * not three unrelated lists stapled together.
 *
 * Stateless: the basket arrives as ids, because before sign-in it lives on the
 * client and there is no cart to read. Books already in the basket are never
 * returned. Empty list when nothing in the basket has an embedding yet.
 *
 * Public — no auth required. A token additionally filters out books the caller
 * has already rejected.
 */
router.get('/recommendations', optionalAuth, booksController.basketRecommendations);

/**
 * GET /books
 * Query params: q, genre, availability, productForm, publishingStatus, publisher,
 * isbn, yearMin, yearMax, priceMin, priceMax, currency, sortBy, sort, limit,
 * offset, dedupe, shoppable, cursor
 *
 * `q` matches both title and author name. Title matches rank first, except when
 * nothing matched a title properly — then an exact author match outranks the
 * fuzzy title near-misses. `total` stays capped for searches (see
 * totalIsApproximate); paginate on `hasMore`.
 *
 * `dedupe=true` collapses same-titled editions down to the best one (see
 * dedupeByTitle in lib/dedupe.ts) — off by default so every edition stays
 * visible; when on, totalIsApproximate is always true, since the row count no
 * longer matches the deduped item count. Deduped requests should paginate
 * with `cursor` rather than offset — the response carries `nextCursor` which
 * is either an opaque token to pass back or null when the end is reached.
 * Cursor pagination guarantees a title cannot appear on two pages; naive
 * offset pagination on the deduped path could, because two raw editions of
 * one book can straddle a page boundary.
 *
 * `isbn` matches exactly (hyphens stripped); `yearMin`/`yearMax` bound
 * publication date, excluding undated books; `priceMin`/`priceMax` bound the
 * supplier price and are **only valid with `shoppable=true`**, since that is
 * the only path that consults it — sending them otherwise is a 400 rather than
 * a page that silently came back unfiltered. Price bounds are major units of
 * `currency` (defaulting to the currency the request would be quoted in) and
 * are converted to GBP pence server-side.
 *
 * `sortBy=title|newest` picks the ordering field and `sort=asc|desc` its
 * direction; a bare `sort` still means title. Both are ignored when `q` is
 * present, where relevance ranking wins. There is no price ordering — see
 * buildSortOrderBy for why.
 *
 * `shoppable=true` narrows the results to what the e-commerce section can
 * list: an ISBN13, a live Gardners price, and no unsuppliable report code.
 * Out-of-stock titles are kept — each result carries `inStock` for the shop to
 * badge — because stock moves hourly and a book vanishing from the catalogue
 * mid-browse is worse than one shown as temporarily unavailable. It is not a
 * sellability guarantee: market restrictions need a destination country, which
 * this public endpoint does not have, so they stay enforced at add-to-cart.
 *
 * Public — no auth required.
 */
router.get('/', booksController.list);

/**
 * GET /books/:id
 * Returns full book detail including descriptions, subjects, contributors, genres, prices.
 * Public — no auth required. If a valid access token is supplied, the response
 * also includes `userStatus` (the caller's shelf entry for this book: reading
 * status, liked flag, note) — null if they have no entry, or if the request
 * is unauthenticated.
 */
router.get('/:id', optionalAuth, booksController.getById);

/**
 * GET /books/:id/similar?limit=10
 * Returns books ranked by cosine similarity to the given book's embedding
 * ("You May Also Like"). Excludes the book itself. Empty list if the book
 * has no embedding yet.
 *
 * Public — no auth required, because the product page it appears on is public
 * and a shop cannot ask someone to sign in before it will recommend anything.
 * A valid access token still improves it: books the caller has already
 * rejected are filtered out.
 */
router.get('/:id/similar', optionalAuth, booksController.similar);

export default router;
