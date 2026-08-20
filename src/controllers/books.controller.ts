import { Request, Response } from 'express';
import { z } from 'zod';
import { booksService, decodeDedupeCursor } from '../services/books.service';
import { userBooksService } from '../services/user-books.service';
import { interactionsService } from '../services/interactions.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

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

const similarSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

const listSchema = z.object({
  q: z.string().min(1).max(200).optional(),
  genre: z.string().min(1).max(300).optional(),
  availability: z.string().length(2).optional(),
  productForm: z.string().min(1).max(10).optional(),
  publishingStatus: z.string().length(2).optional(),
  publisher: z.string().min(1).max(200).optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // Opt-in: collapses same-titled editions down to the best one — see dedupeParam above.
  dedupe: dedupeParam,
  /**
   * Opt-in: drops books the shop cannot list — no ISBN13, no price, or an
   * unsuppliable Gardners report code. Off by default: discovery, search and
   * reading lists browse the whole catalogue, and only the e-commerce section
   * wants the narrowed view. Out-of-stock books are kept and carry `inStock`
   * so the shop can badge them. See buildShoppableCondition in books.service
   * for what this does and does not check.
   */
  shoppable: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /**
   * Opaque pagination token, only meaningful when dedupe=true. When supplied
   * the server resumes at the raw position it encodes and filters out any
   * titles the previous page returned, so a title cannot appear twice
   * across pages. Ignored (with no error) when dedupe is off.
   */
  cursor: z.string().min(1).max(4096).optional(),
});

export const booksController = {
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

  async list(req: Request, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      // Cursor is only meaningful with dedupe. Silently ignoring it in the
      // offset-only path is more forgiving than a 400 and keeps a hand-crafted
      // request working when someone drops the flag.
      const cursor = parsed.data.dedupe ? decodeDedupeCursor(parsed.data.cursor) : null;

      const result = await booksService.list({ ...parsed.data, cursor });
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
      const results = await booksService.similar(id, parsed.data.limit, userId);
      res.status(200).json({ books: results });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },
};
