import { Router } from 'express';
import { booksController } from '../controllers/books.controller';

/**
 * v2 of the catalogue list endpoint, and nothing else.
 *
 * Only `GET /books` differs between the two versions, so only `GET /books` is versioned.
 * There is no `/api/v2/books/search`, no `/api/v2/books/:id` and no `/api/v2` anything
 * else: a v2 route that behaved identically to its v1 twin would be a second URL to keep
 * in step for no benefit, and the first time the two drifted it would be by accident.
 * Clients point their catalogue search at v2 and leave every other call on v1.
 *
 * Both versions share booksController and booksService, so this is a different contract
 * over the same code rather than a fork of it.
 */
const router = Router();

/**
 * GET /books  (v2 — mounted at /api/v2/books)
 * Query params: q, type, genre, availability, productForm, publishingStatus,
 * publisher, isbn, yearMin, yearMax, priceMin, priceMax, currency, sortBy, sort,
 * limit, offset, dedupe, shoppable, cursor
 *
 * Identical to v1 in every respect but one: `type=title|author` picks which side of the
 * catalogue `q` matches, defaulting to `title`. The two are never searched together —
 * each is a different query against a different index with its own tier ladder, and
 * blending them means ranking a title match against a name match, which no index can
 * order. A caller that wants both asks twice and shows two lists. There is no `type=all`;
 * it is a 400, not a synonym for the v1 behaviour.
 *
 * `type=author` matches any contributor — editors, translators and illustrators included
 * — with ONIX A01 authors ranked above them, so searching an editor by name still finds
 * the volume they edited.
 *
 * `type` is accepted and inert when `q` is absent, so a UI can keep one query-string
 * builder for both its browse and its search.
 *
 * **This is not a drop-in swap from v1.** A search box wired to `?q=` returns title
 * matches only here, where v1 would have folded in that author's books. Moving a search
 * box to v2 means deciding which side it searches, or issuing both requests.
 *
 * Every other parameter, the response shape, pagination (including `cursor`/`nextCursor`
 * on the dedupe path), the `total` cap and `totalIsApproximate` behave exactly as they do
 * on v1 — see books.routes.ts for the full notes on each.
 *
 * Public — no auth required.
 */
router.get('/', booksController.listV2);

export default router;
