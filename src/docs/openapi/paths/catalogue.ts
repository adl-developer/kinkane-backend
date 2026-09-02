import {
  ref, resp, json, object, param, arrayOf, authErrors, plusErrors, publicEndpoint,
} from '../helpers';

const TAG = 'Catalogue';
const DISCOVERY = 'Discovery';

const bookIdParam = param('id', 'path', { type: 'integer' },
  'Kinkané book id, as returned by any list or search endpoint. Not an ISBN.', { example: 48213 });

// Everything both versions of the catalogue list accept apart from `q` and `type`, and the
// response they both return. Shared rather than copied: the versions differ only in how `q`
// is matched, and a filter documented on one but not the other would be a doc bug that
// looks like a behaviour difference.
const listFilterParams = [
  param('genre', 'query', { type: 'string', maxLength: 300 },
    'Genre name or slug. Comma-separate for several.', { example: 'literary-fiction' }),
  param('availability', 'query', { type: 'string', minLength: 2, maxLength: 2 },
    'ONIX availability code — `21` in stock, `31` out of stock.', { example: '21' }),
  param('productForm', 'query', { type: 'string', maxLength: 10 },
    'ONIX product form — `BC` paperback, `BB` hardback, `AJ` audio.', { example: 'BC' }),
  param('publishingStatus', 'query', { type: 'string', minLength: 2, maxLength: 2 },
    'ONIX publishing status — `04` is active.', { example: '04' }),
  param('publisher', 'query', { type: 'string', maxLength: 200 },
    'Publisher imprint name.', { example: 'Penguin' }),
  param('isbn', 'query', { type: 'string', maxLength: 20 },
    'ISBN-13, exact. Hyphens and spaces are stripped, so the number as printed on the book works.', { example: '9780241988138' }),
  param('yearMin', 'query', { type: 'integer', minimum: 1450, maximum: 2200 },
    'Earliest publication year, inclusive. Books with no publication date are excluded from a year-filtered result.'),
  param('yearMax', 'query', { type: 'integer', minimum: 1450, maximum: 2200 },
    'Latest publication year, inclusive.'),
  param('priceMin', 'query', { type: 'number', minimum: 0 },
    'Lowest price, inclusive, in major units of `currency` — `10` means $10, not 1000 cents. **Requires `shoppable=true`**; the price lives on the supplier row only that path consults, and sending it without the flag is a 400 rather than a silently unfiltered page. The boundary is approximate by up to a penny, because the displayed price is converted from GBP with a rounding buffer.'),
  param('priceMax', 'query', { type: 'number', minimum: 0 },
    'Highest price, inclusive, in major units of `currency`. Same rules as `priceMin`.'),
  param('currency', 'query', { type: 'string', minLength: 3, maxLength: 3 },
    'Which currency `priceMin`/`priceMax` are expressed in. Defaults to the currency this request would be quoted in, so a client filtering in the currency it displays can omit it.', { example: 'USD' }),
  param('sortBy', 'query', { type: 'string', enum: ['title', 'newest'] },
    'Field to order by. `newest` orders on publication date, undated books last. **Ignored whenever `q` is set** — relevance ranking wins, because a page *selected* by fuzzy relevance and then reordered by title is neither ranking. There is no `price` option: ordering on the supplier price means evaluating a correlated subquery for every candidate row before the limit applies, and that has not been measured against the full table yet.'),
  param('sort', 'query', { type: 'string', enum: ['asc', 'desc'] },
    'Direction for `sortBy`. On its own it still means title sort, the meaning it had before `sortBy` existed. Omit to rank by relevance, which is what you want whenever `q` is set.'),
  param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    'Items per page (1–50).'),
  param('offset', 'query', { type: 'integer', minimum: 0, default: 0 },
    'Items to skip. **Ignored when `dedupe=true`** — use `cursor` there instead.'),
  param('dedupe', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
    'Collapse same-titled editions to one. Off by default so every edition stays visible.'),
  param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
    '**Orders the page the way a shop has to — it does not filter.** Three bands, in this order: (1) in stock, (2) orderable but unstocked — the extended catalogue and print-on-demand titles, which never have a shelf, (3) unsellable: no ISBN13, no live price, or an unsuppliable supplier report code. Nothing is excluded, so `shoppable=true` and `shoppable=false` return the same books in a different order.\n\n**Also adds `shoppable`, `inStock`, `unitPriceMinor`, `compareAtMinor` and `currency` to every row.** `shoppable: false` marks the third band — never give those rows an Add button, and they carry no price or stock fields at all, since an unsellable book with a supplier price behind it is not an offer. `shoppable: true, inStock: false` is the second band: orderable, with a longer lead time. Ignore the `prices` array on a shop surface; it is ONIX edition metadata and disagrees with the supplier feed on part of the catalogue.\n\nRanking rather than filtering because a catalogue that changes size with a query parameter cannot be paged through consistently, and stock in particular moves hourly — a book disappearing mid-browse reads as a bug. `priceMin`/`priceMax` are unaffected and still filter, since a price range is a request for a shelf rather than an ordering.\n\nNot a guarantee of sellability either way: rights restrictions depend on a destination country this endpoint has none of, so they are enforced at add-to-cart instead.'),
  param('cursor', 'query', { type: 'string', maxLength: 4096 },
    'Opaque token from the previous response’s `nextCursor`. Only meaningful with `dedupe=true`; silently ignored otherwise.'),
];

const listResponses = {

  200: json('A page of books.',
    object({
      books: arrayOf(ref('BookSummary')),
      total: { type: 'integer', example: 137 },
      totalIsApproximate: {
        type: 'boolean',
        description:
          'True when `total` is a cap rather than a count — always the case for deduped requests, and for searches over the cap. Render "137+" rather than "137" when this is set.',
        example: false,
      },
      hasMore: { type: 'boolean', example: true },
      nextCursor: {
        type: 'string',
        nullable: true,
        description: 'Deduped requests only. Pass back as `cursor`; `null` at the end of the results.',
        example: null,
      },
      limit: { type: 'integer', example: 20 },
      offset: { type: 'integer', example: 0 },
    })),
  400: resp('ValidationError'),
  429: resp('RateLimited'),
  500: resp('ServerError'),
};

const listPaginationNotes = [
  '**Pagination has two modes, and they are not interchangeable:**',
  '',
  '- *Default (`dedupe=false`)* — ordinary `limit`/`offset`. `total` is exact when browsing, and capped for searches (watch `totalIsApproximate`). Paginate on `hasMore`.',
  '- *Deduped (`dedupe=true`)* — collapses the six editions of one title down to the best one. **Use `cursor`, not `offset`.** Two raw editions of one book can straddle a page boundary, so naive offset pagination on this path can show the same title twice. Pass the response’s `nextCursor` back on the next request; `null` means you have reached the end. `totalIsApproximate` is always true here, because the row count no longer matches the item count.',
];

export const cataloguePaths = {
  '/api/v1/books': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Browse and search the catalogue',
      description: [
        'The main catalogue query. Every filter is optional; with none supplied it pages through the whole catalogue.',
        '',
        '**Searching.** `q` matches book titles *and* author names in one pass. Title matches rank first — except when nothing matched a title properly, in which case an exact author match outranks the fuzzy title near-misses. That rule is why searching an author\u2019s name returns their books rather than a list of coincidental title matches.',
        '',
        '**This endpoint is frozen.** It does not take `type`, and sending one is a 400 rather than being ignored — see `GET /api/v2/books`, which does. Nothing about how `q` is matched here will change again; that is what v2 is for.',
        '',
        ...listPaginationNotes,
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'Free-text search across title and author name.', { example: 'evaristo' }),
        ...listFilterParams,
      ],
      responses: listResponses,
    },
  },
  '/api/v2/books': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Browse and search the catalogue (choose title or author)',
      description: [
        'Identical to `GET /api/v1/books` in every respect but one: `q` matches **one** side of the catalogue, chosen by `type`.',
        '',
        '**Searching.** `type` picks book titles (the default) or contributor names. The two are never blended into one page — each is a query against a different index with its own relevance ladder, and ranking a title match against a name match needs an ordering no index can supply. A UI that wants both runs two requests and presents two lists. There is no `type=all`: it is a 400, not a synonym for the v1 behaviour.',
        '',
        '`type=author` matches **any** contributor, with ONIX A01 authors ranked above editors, translators and illustrators — so searching an editor by name still finds the volume they edited, just below the books actually written by anyone of that name.',
        '',
        '**Not a drop-in swap from v1.** A search box wired to `?q=` gets title matches only here, where v1 would have folded in that author\u2019s books. Moving one to v2 means deciding which side it searches, or issuing both requests.',
        '',
        ...listPaginationNotes,
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'Free-text search. Which side it matches is set by `type`.', { example: 'evaristo' }),
        param('type', 'query', { type: 'string', enum: ['title', 'author'], default: 'title' },
          'Which side of the catalogue `q` searches. `title` (default) matches book titles; `author` matches contributor names. There is no combined mode — run two requests if you want both. Ignored when `q` is absent.',
          { example: 'author' }),
        ...listFilterParams,
      ],
      responses: listResponses,
    },
  },
  '/api/v1/books/search': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Typeahead suggestions',
      description: [
        'Fast ranked suggestions for a search-as-you-type box. Returns **books**, never bare author entities — typing an author’s name gives you that author’s books. For author entities themselves, use `GET /authors/search`.',
        '',
        'Ranking runs prefix match → word prefix → trigram similarity → full-text search as a last resort. Title matches lead, but author matches hold a reserved share of the list so a query that happens to match both cannot crowd them out entirely.',
        '',
        'Minimum 1 character.',
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 100 },
          'What the user has typed so far.', { required: true, example: 'girl wom' }),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 15, default: 8 },
          'Suggestions to return (1–15).'),
        param('type', 'query', { type: 'string', enum: ['all', 'title', 'author'], default: 'all' },
          'Restrict matching to one side. `all` matches both title and author name.'),
        param('dedupe', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Collapse same-titled editions to the best one. Mobile clients generally want `true` — a suggestion list showing the same title six times is not useful.'),
      ],
      responses: {
        200: json('Ranked suggestions.', object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/books/{id}': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Get one book',
      description:
        'The full catalogue record — descriptions, contributors, subjects, genres and supplier prices.\n\nAuthentication is **optional and worth sending**: with a valid token the response also carries `userStatus`, the caller’s own shelf entry for this book (reading status, liked flag, note). Anonymous callers get `null` there.',
      parameters: [bookIdParam],
      responses: {
        200: json('The book.', ref('BookDetail')),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/books/{id}/similar': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Books similar to this one ("You may also like")',
      description:
        'Ranks the catalogue by cosine similarity to this book’s embedding, excluding the book itself.\n\n**Public** — the product page this appears on does not require an account. Sending a valid token improves it rather than enabling it: books the caller has already swiped away are filtered out.\n\nReturns an **empty list, not an error**, when the book has no embedding yet — newly ingested titles are embedded asynchronously. Treat empty as "hide the section".',
      parameters: [
        bookIdParam,
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          'How many to return (1–20).'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can sell, **and add the live shop fields** — `unitPriceMinor`, `compareAtMinor`, `currency` and `inStock` — so a carousel with an Add button needs no second request to price what it shows. Pass `true` from any surface with an Add button; otherwise this feed can offer a book the cart will refuse. Off by default so existing callers are unaffected.\n\n**The feed is cached; the price is not.** The cached pool holds books only and the price is attached on every request, so a supplier price change is visible immediately while the ordering may be up to an hour old. A stale ordering is invisible to a shopper; a stale price is one number on the shelf and another in the basket.'),
      ],
      responses: {
        200: json('Similar books, most similar first. May be empty.',
          object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
      },
    },
  },

  '/api/v1/books/recommendations': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: '"You may also like" for a whole basket',
      description: [
        'The cart page carousel. Averages the embeddings of everything in the basket and returns the nearest titles to that centre.',
        '',
        'Not the same as calling `/books/{id}/similar` for each item and merging: a basket of one cookbook and two thrillers should suggest something that suits the *shopper*, rather than three unrelated lists stapled together.',
        '',
        '**Stateless** — the basket arrives as ids, because before sign-in it lives on the client and there is no cart to read. Books already in the basket are never returned.',
        '',
        'Returns an **empty list, not an error**, when nothing in the basket has an embedding yet. Treat empty as "hide the section".',
        '',
        'Public. A token additionally filters out books the caller has already swiped away.',
      ].join('\n'),
      parameters: [
        param('bookIds', 'query', { type: 'string' },
          'Comma-separated book ids — the basket. Duplicates are ignored.', { example: '48213,50127' }),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 8 }, 'How many to return.'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can sell, **and add the live shop fields** — `unitPriceMinor`, `compareAtMinor`, `currency` and `inStock` — so a rail with an Add button needs no second request to price what it shows. Pass `true` from any surface with an Add button; otherwise this feed can offer a book the cart will refuse. Off by default so existing callers are unaffected.\n\n**The feed is cached; the price is not.** The cached pool holds books only and the price is attached on every request, so a supplier price change shows immediately while the ordering may be up to an hour old.'),
      ],
      responses: {
        200: json('Recommendations, most relevant first. May be empty.',
          object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
      },
    },
  },

  '/api/v1/authors/search': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Typeahead for author names',
      description:
        'Deduplicated author entities with a book count, for browsing by author rather than by title. Ranked prefix → word prefix → trigram similarity. Minimum 1 character.',
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 100 },
          'Partial author name.', { required: true, example: 'evar' }),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 15, default: 8 },
          'Suggestions to return (1–15).'),
      ],
      responses: {
        200: json('Matching authors.',
          object({
            authors: arrayOf(object({
              name: { type: 'string', example: 'Bernardine Evaristo' },
              bookCount: { type: 'integer', example: 11 },
            })),
          })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/genres': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'List all genres',
      description:
        'The complete genre list — id, name and slug. Small and stable; cache it client-side rather than fetching per screen.\n\nNote these are the *catalogue* genres. The onboarding quiz uses its own fixed 21-value vocabulary, which is documented on `POST /recommendations` and is not this list.',
      responses: {
        200: json('Every genre.', object({ genres: arrayOf(ref('Genre')) })),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  // ── Discovery feeds ────────────────────────────────────────────────────────

  '/api/v1/explore/trending': {
    get: {
      tags: [DISCOVERY],
      ...publicEndpoint,
      summary: 'Trending books',
      description: [
        'The most interacted-with books of the last 30 days, ranked by a weighted score over views, wishlist adds and picks from recommendations. Falls back to recently published titles to fill the list when data is sparse.',
        '',
        'The ranking is **global** — everyone sees the same list — with one exception: send an access token and books the caller has swiped away (and other editions of them) are filtered out. Worth doing; a "trending" rail containing a book the user explicitly rejected reads as broken.',
        '',
        'Cached for 1 hour.',
      ].join('\n'),
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          'How many books (1–20).'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can sell, **and add the live shop fields** — `unitPriceMinor`, `compareAtMinor`, `currency` and `inStock` — so a rail with an Add button needs no second request to price what it shows. Pass `true` from any surface with an Add button; otherwise this feed can offer a book the cart will refuse. Off by default so existing callers are unaffected.\n\n**The feed is cached; the price is not.** The cached pool holds books only and the price is attached on every request, so a supplier price change shows immediately while the ordering may be up to an hour old.'),
      ],
      responses: {
        200: json('Trending books.', object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/explore/bestsellers': {
    get: {
      tags: [DISCOVERY],
      ...publicEndpoint,
      summary: 'Bestsellers, by actual copies sold',
      description: [
        'Ranked by units genuinely sold through Kinkané in the window. Built from our own order history — the wholesaler supplies price, stock and availability but no sales rank of any kind, so there is no external chart being read here.',
        '',
        '**When nothing sold in the window, this returns trending books instead and sets `source` to `trending`.** Always read `source` before you write the section heading — a discovery list presented as a sales chart is untrue, and the field is the only thing distinguishing them. `books` can still be empty if there is neither sales nor interaction data.',
        '',
        'Identical for every caller — a factual ranking is not personalised, so nothing is filtered per viewer. Cached for an hour, cleared nightly.',
      ].join('\n'),
      parameters: [
        param('window', 'query', { type: 'string', enum: ['7d', '30d', '90d', 'all_time'], default: '30d' },
          'The sales window to rank over.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          'How many books (1–20).'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can sell, **and add the live shop fields** — `unitPriceMinor`, `compareAtMinor`, `currency` and `inStock` — so a rail with an Add button needs no second request to price what it shows. Pass `true` from any surface with an Add button; otherwise this feed can offer a book the cart will refuse. Off by default so existing callers are unaffected.\n\nApplies to the trending fallback too, so a shoppable request stays shoppable when nothing sold.\n\n**The feed is cached; the price is not.** The cached pool holds books only and the price is attached on every request, so a supplier price change shows immediately while the ordering may be up to an hour old.'),
      ],
      responses: {
        200: json('Bestsellers, or trending books (`source: trending`) if nothing sold in the window. The book shape is the same either way.',
          object({
            window: { type: 'string', example: '30d' },
            source: {
              type: 'string',
              enum: ['orders', 'trending'],
              description: '`orders` — a genuine ranking by copies sold. `trending` — nothing sold in this window, so these are trending books ranked by interaction signal, not a sales chart. Label the section accordingly.',
              example: 'orders',
            },
            books: arrayOf(ref('BookSummary')),
          })),
        400: resp('ValidationError'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/explore/personalized': {
    get: {
      tags: [DISCOVERY],
      summary: 'Personalised recommendations feed',
      description: [
        'Books ranked by cosine similarity to the caller’s stored preference embedding, built from their onboarding answers. Excludes anything already on their shelf and anything they have swiped away.',
        '',
        'Returns an **empty list** — not an error — when the embedding is not ready yet. That is the normal state for the first moments after signup, and also right after `PATCH /recommendations/refresh`, which regenerates the embedding in the background.',
        '',
        'Cached for 1 hour per user. **Requires Kinkané Plus.**',
      ].join('\n'),
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          'How many books (1–20).'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can sell, **and add the live shop fields** — `unitPriceMinor`, `compareAtMinor`, `currency` and `inStock` — so a rail with an Add button needs no second request to price what it shows. Pass `true` from any surface with an Add button; otherwise this feed can offer a book the cart will refuse. Off by default so existing callers are unaffected.\n\n**The feed is cached; the price is not.** The cached pool holds books only and the price is attached on every request, so a supplier price change shows immediately while the ordering may be up to an hour old.'),
      ],
      responses: {
        200: json('Personalised books. Empty while the embedding is still being built.',
          object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
        ...plusErrors,
      },
    },
  },
};
