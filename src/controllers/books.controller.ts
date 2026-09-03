import { Request, Response } from 'express';
import { z } from 'zod';
import { booksService, decodeDedupeCursor } from '../services/books.service';
import type { BookSearchType } from '../services/books.service';
import { userBooksService } from '../services/user-books.service';
import { interactionsService } from '../services/interactions.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { config } from '../config';
import { fromPresentment, resolveCurrency, resolveRequestCountry } from '../services/commerce/pricing';
import { minorUnitsPerMajor } from '../lib/money';

// z.coerce.boolean() would treat the literal string "false" as truthy (any non-empty
// string coerces to true), so accepted values are explicit — see refreshQuerySchema in
// recommendations.controller.ts for the same pattern.
const dedupeParam = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const suggestionsSchema = z.object({
  q: z.string().min(1, 'Query must not be empty').max(100),
  limit: z.coerce.number().int().min(1).max(15).default(8),
  // Defaults to matching both title and author. The single-sided values stay accepted so
  // existing callers that pass type=title or type=author keep their current behaviour.
  type: z.enum(['all', 'title', 'author']).default('all'),
  // Opt-in: collapses same-titled editions down to the best one (cover > complete dataset >
  // newest publication date > has a price). Off by default so the web app can show every
  // edition; the mobile app passes ?dedupe=true.
  dedupe: dedupeParam,
});

// No `shoppable` here, unlike the catalogue listing. A recommendation is an
// invitation to buy: every "you may also like" card carries an Add button, so
// the books are always sellable ones and the live price and stock are always on
// the row. There is nothing for a client to ask for, and nothing it can forget.
// A stray `?shoppable=` is ignored rather than rejected, so clients written
// against the old flag keep working and get what they were asking for anyway.
const similarSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// Everything both versions of GET /books accept. `type` is the only difference between
// them, and it is validated separately (see searchTypeParam) rather than extended onto
// this object: the two .refine() calls at the bottom turn it into a ZodEffects, which has
// no .extend(). Parsing the one parameter on its own is less machinery than making the
// refinements generic, and it keeps every shared filter defined exactly once.
const listSchemaBase = z.object({
  q: z.string().min(1).max(200).optional(),
  genre: z.string().min(1).max(300).optional(),
  availability: z.string().length(2).optional(),
  productForm: z.string().min(1).max(10).optional(),
  publishingStatus: z.string().length(2).optional(),
  publisher: z.string().min(1).max(200).optional(),
  // ISBN-13 as it is printed, hyphens and spaces optional. Matched exactly:
  // an ISBN is either the book or it is not, and a partial one is a typo.
  isbn: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{13}$/.test(v), { message: 'ISBN must be 13 digits' })
    .optional(),
  // Inclusive publication-year bounds. The floor is the year of the oldest
  // plausible catalogue record rather than 0, so a mistyped year cannot produce
  // a range that scans everything.
  yearMin: z.coerce.number().int().min(1450).max(2200).optional(),
  yearMax: z.coerce.number().int().min(1450).max(2200).optional(),
  // Price bounds in **major units** of `currency` — 0 to 100 means $0-$100,
  // matching the filter UI. Converted to GBP pence before it reaches the query.
  priceMin: z.coerce.number().min(0).max(100_000).optional(),
  priceMax: z.coerce.number().min(0).max(100_000).optional(),
  // Which currency the price bounds are expressed in. Defaults to the currency
  // this request would be quoted in, so a client that shows dollars and filters
  // in dollars needs to send nothing.
  currency: z.string().length(3).optional(),
  sortBy: z.enum(['title', 'newest']).optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // Opt-in: collapses same-titled editions down to the best one — see dedupeParam above.
  dedupe: dedupeParam,
  /**
   * Opt-in: orders the results the way a shop has to, rather than narrowing
   * them. Three bands, in this order — in stock, orderable but unstocked, then
   * everything the shop cannot sell at all (no ISBN13, no price, or an
   * unsuppliable Gardners report code). Each row carries `shoppable` and
   * `inStock` so a listing can badge the tail or cut it off itself.
   *
   * It used to *drop* that last band. Turning the filter into a ranking means
   * `shoppable=true` and `shoppable=false` now return the same books in a
   * different order, so a client that was relying on the exclusion — an Add
   * button on every row, say — has to read `shoppable` per row instead.
   *
   * Off by default: discovery, search and reading lists browse the whole
   * catalogue in its natural order, and only the e-commerce section wants the
   * shop's. See SHOP_BAND in lib/shoppable for the bands, and
   * buildShopBandCondition for what the ranking does and does not consider.
   */
  shoppable: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /**
   * Opaque pagination token, only meaningful when dedupe=true. When supplied
   * the server resumes at the raw position it encodes and filters out any
   * titles the previous page returned, so a title cannot appear twice
   * across pages. Ignored (with no error) when dedupe is off.
   */
  cursor: z.string().min(1).max(4096).optional(),
})
  .refine((v) => v.yearMin === undefined || v.yearMax === undefined || v.yearMin <= v.yearMax, {
    message: 'yearMin must not be after yearMax',
    path: ['yearMin'],
  })
  .refine((v) => v.priceMin === undefined || v.priceMax === undefined || v.priceMin <= v.priceMax, {
    message: 'priceMin must not exceed priceMax',
    path: ['priceMin'],
  })
  // The price lives on the Gardners stock row, which only the shoppable path
  // consults. Rejecting rather than ignoring: a filtered page that quietly came
  // back unfiltered is a bug the client cannot see. Still required now that
  // `shoppable` ranks rather than filters — the bounds themselves remain a real
  // filter (see buildPriceBoundsCondition), and they are only meaningful
  // against the currency and live prices the shoppable path resolves.
  .refine((v) => (v.priceMin === undefined && v.priceMax === undefined) || v.shoppable, {
    message: 'priceMin/priceMax require shoppable=true — only shoppable books have a price',
    path: ['priceMin'],
  });

/**
 * `type` on `GET /api/v2/books`. Which side of the catalogue `q` searches, defaulting to
 * titles.
 *
 * There is deliberately no 'all': the two are never blended into one page. A caller that
 * wants both asks twice and presents two lists, which is the only honest shape — ranking a
 * title match against a name match needs an ordering no index can supply. Ignored when `q`
 * is absent, so a UI can keep one query-string builder for both its browse and its search.
 *
 * v1 does not accept this at all — see rejectTypeParam.
 */
const searchTypeParam = z.enum(['title', 'author']).default('title');

/**
 * v1's half of the same contract: `type` is rejected outright rather than ignored.
 *
 * Ignoring it would be the quieter option and the wrong one. A client that has already
 * adopted `type` would keep getting the blended page and no indication that the parameter
 * it is sending does nothing — an author search silently answered with title matches looks
 * like a ranking bug, not a versioning mistake. The 400 names v2 so the fix is the URL.
 *
 * Returns true when it has already answered the request.
 */
function rejectTypeParam(req: Request, res: Response): boolean {
  if (req.query.type === undefined) return false;
  res.status(400).json({
    error: {
      type: [
        'type is not supported on v1 of this endpoint, which always searches titles and author names together. Use GET /api/v2/books?type=title|author to choose one side.',
      ],
    },
  });
  return true;
}

const basketRecsSchema = z.object({
  // Comma-separated so this stays a cacheable GET. Bounded to the same ceiling
  // as a cart, because a basket cannot legitimately be larger than one.
  bookIds: z.string().min(1).transform((v, ctx) => {
    const ids = v.split(',').map((part) => Number(part.trim()));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bookIds must be positive integers' });
      return z.NEVER;
    }
    if (ids.length > config.commerce.cart.maxItems) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many books' });
      return z.NEVER;
    }
    return [...new Set(ids)];
  }),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

/**
 * The currency this request's recommendations should be quoted in.
 *
 * Resolved per request rather than baked into a cached feed, for the same
 * reason the price itself is attached after the cache: a visitor in Lagos and
 * one in Berlin hit the same cached pool and must not see each other's money.
 *
 * It used to return undefined for a caller that had not passed `shoppable`,
 * which is what a feed with no prices on it looked like. Recommendations are
 * always priced now, so there is always a currency to resolve.
 */
export async function shopCurrency(req: Request): Promise<string> {
  return resolveCurrency({ countryCode: await resolveRequestCountry(req) });
}

/**
 * The shared body of both versions of `GET /books`. Everything except which side `q`
 * matches is identical, so it lives here once — a new filter, a pagination fix or a
 * pricing change lands on v1 and v2 together, which is the point of them sharing a
 * service rather than v2 being a fork.
 *
 * `searchType` is undefined for v1, and that is meaningful rather than merely absent:
 * booksService.list reads it as "search both sides and merge" (see fetchBlendedSearchPage).
 * It is passed positionally rather than read off the query so neither version can pick up
 * the other's behaviour from a stray parameter.
 */
async function runList(
  req: Request,
  res: Response,
  searchType: BookSearchType | undefined,
): Promise<void> {
  const parsed = listSchemaBase.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    // Cursor is only meaningful with dedupe. Silently ignoring it in the
    // offset-only path is more forgiving than a 400 and keeps a hand-crafted
    // request working when someone drops the flag.
    const cursor = parsed.data.dedupe ? decodeDedupeCursor(parsed.data.cursor) : null;

    const { priceMin, priceMax, currency, ...rest } = parsed.data;

    // Bounds arrive in the customer's currency and the catalogue stores GBP
    // pence, so they are converted once here rather than per row. The
    // currency is resolved the same way the cart resolves it, so the numbers
    // being filtered on are the numbers the shop displayed.
    // Resolved for every shoppable request, not only filtered ones: it is
    // both the currency the bounds are read in and the currency prices come
    // back in, so a client filters and displays in the same units.
    const resolved =
      rest.shoppable || priceMin !== undefined || priceMax !== undefined
        ? resolveCurrency({ requested: currency, countryCode: await resolveRequestCountry(req) })
        : undefined;

    let priceMinGbpPence: number | undefined;
    let priceMaxGbpPence: number | undefined;
    if (resolved && (priceMin !== undefined || priceMax !== undefined)) {
      const perMajor = minorUnitsPerMajor(resolved);
      if (priceMin !== undefined) {
        priceMinGbpPence = fromPresentment(Math.round(priceMin * perMajor), resolved);
      }
      if (priceMax !== undefined) {
        priceMaxGbpPence = fromPresentment(Math.round(priceMax * perMajor), resolved);
      }
    }

    const result = await booksService.list({
      ...rest,
      // Spread before this line cannot contain searchType — listSchemaBase has no `type`
      // — so v1 never sets the key at all, which is what booksService.list keys the
      // blended path (and its cache entries) on.
      ...(searchType ? { searchType } : {}),
      currency: resolved,
      priceMinGbpPence,
      priceMaxGbpPence,
      cursor,
    });
    res.status(200).json({
      books: result.books,
      total: result.total,
      // `total` is capped for search queries (see SEARCH_COUNT_CAP) — when
      // totalIsApproximate is true it's a floor, not an exact count, and clients should
      // paginate on hasMore rather than computing page counts from total.
      totalIsApproximate: result.totalIsApproximate,
      hasMore: result.hasMore,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      // Present only for dedupe requests. Pass this back as ?cursor= for the
      // next page — offset-style pagination on the dedupe path could return
      // the same title on consecutive pages, which cursors prevent.
      nextCursor: result.nextCursor,
    });
  } catch (err: unknown) {
    const e = err as Error;
    res.status(500).json({ error: e.message });
  }
}

export const booksController = {
  /** GET /api/v1/books/recommendations?bookIds=1,2,3 */
  async basketRecommendations(req: Request, res: Response): Promise<void> {
    const parsed = basketRecsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    // Optional auth: guests hold their basket client-side, so this is usually
    // anonymous. A signed-in caller additionally gets rejected books filtered.
    const userId = (req as AuthenticatedRequest).user?.id;
    const books = await booksService.basketRecommendations(
      parsed.data.bookIds,
      parsed.data.limit,
      userId,
      await shopCurrency(req),
    );

    res.status(200).json({ books });
  },

  async suggestions(req: Request, res: Response): Promise<void> {
    const parsed = suggestionsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const results = await booksService.suggestions(parsed.data.q, parsed.data.limit, parsed.data.type, parsed.data.dedupe);
      res.status(200).json({ suggestions: results, type: parsed.data.type });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async authorSuggestions(req: Request, res: Response): Promise<void> {
    const parsed = suggestionsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const results = await booksService.authorSuggestions(parsed.data.q, parsed.data.limit);
      res.status(200).json({ authors: results });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  /**
   * `GET /api/v1/books` — frozen. `q` matches titles *and* author names in one page,
   * merged title-first. No `type`; sending one is a 400 (see rejectTypeParam).
   *
   * This is not the behaviour anyone would design today — fetchBlendedSearchPage in
   * books.service.ts says why at length — and it is kept because clients are pointed at
   * it. v2 is where the blending stops.
   */
  async list(req: Request, res: Response): Promise<void> {
    if (rejectTypeParam(req, res)) return;
    await runList(req, res, undefined);
  },

  /**
   * `GET /api/v2/books` — the same parameters plus `type=title|author`, defaulting to
   * `title`. Identical to v1 in every other respect, including pagination, dedupe, price
   * filtering and the response shape; the whole of the difference is which side `q`
   * matches.
   */
  async listV2(req: Request, res: Response): Promise<void> {
    const parsedType = searchTypeParam.safeParse(req.query.type);
    if (!parsedType.success) {
      // Worded here rather than relayed from zod, because the value people actually send
      // is `all`, and "invalid enum value" does not tell them that blending is gone rather
      // than spelled differently.
      res.status(400).json({
        error: {
          type: [
            "type must be 'title' or 'author'. There is no combined mode — run one request per side and present two lists.",
          ],
        },
      });
      return;
    }
    await runList(req, res, parsedType.data);
  },

  async getById(req: Request, res: Response): Promise<void> {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    try {
      // C1 + C2 fix: fetch the book first so the 404 check is never bypassed by
      // a getPublicNotes failure, and so we don't waste a DB/cache round-trip for
      // a non-existent book ID.
      const book = await booksService.getById(id);
      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      // C1 + C4 fix: public notes are a non-critical enhancement — a Redis or DB
      // failure here must not take down the entire book detail response.
      let publicNotes: Awaited<ReturnType<typeof userBooksService.getPublicNotes>> = [];
      try {
        publicNotes = await userBooksService.getPublicNotes(id);
      } catch {
        // degrade gracefully: return empty notes rather than a 500
      }

      // optionalAuth sets req.user only when a valid token was presented —
      // anonymous callers get userStatus: null rather than a 401.
      const userId = (req as Partial<AuthenticatedRequest>).user?.id;
      const userStatus = userId ? await userBooksService.getStatus(userId, id) : null;

      // Record the view as a trending signal. Only for signed-in callers — the
      // interactions table requires a user_id, so anonymous views are dropped
      // rather than attributed. Not awaited: this endpoint is the hottest read in
      // the app and analytics must not sit in front of the response.
      if (userId) {
        interactionsService.recordFireAndForget(userId, id, 'view');
      }

      res.status(200).json({ book, publicNotes, userStatus });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async similar(req: Request, res: Response): Promise<void> {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    const parsed = similarSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const book = await booksService.getById(id);
      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      // Optional-auth: the product page this feeds is public, so there may be
      // no viewer at all. When there is one, their id filters out books they
      // have already rejected; when there isn't, everyone sees the same
      // similarity ranking.
      const userId = (req as AuthenticatedRequest).user?.id;
      const results = await booksService.similar(
        id,
        parsed.data.limit,
        userId,
        await shopCurrency(req),
      );
      res.status(200).json({ books: results });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },
};
