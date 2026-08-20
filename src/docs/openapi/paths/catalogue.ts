import {
  ref, resp, json, object, param, arrayOf, authErrors, plusErrors, publicEndpoint,
} from '../helpers';

const TAG = 'Catalogue';
const DISCOVERY = 'Discovery';

const bookIdParam = param('id', 'path', { type: 'integer' },
  'Kinkané book id, as returned by any list or search endpoint. Not an ISBN.', { example: 48213 });

export const cataloguePaths = {
  '/api/v1/books': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Browse and search the catalogue',
      description: [
        'The main catalogue query. Every filter is optional; with none supplied it pages through the whole catalogue.',
        '',
        '**Searching.** `q` matches titles *and* author names in one pass. Title matches rank first — except when nothing matched a title properly, in which case an exact author match outranks the fuzzy title near-misses. That rule is why searching an author’s name returns their books rather than a list of coincidental title matches.',
        '',
        '**Pagination has two modes, and they are not interchangeable:**',
        '',
        '- *Default (`dedupe=false`)* — ordinary `limit`/`offset`. `total` is exact when browsing, and capped for searches (watch `totalIsApproximate`). Paginate on `hasMore`.',
        '- *Deduped (`dedupe=true`)* — collapses the six editions of one title down to the best one. **Use `cursor`, not `offset`.** Two raw editions of one book can straddle a page boundary, so naive offset pagination on this path can show the same title twice. Pass the response’s `nextCursor` back on the next request; `null` means you have reached the end. `totalIsApproximate` is always true here, because the row count no longer matches the item count.',
      ].join('\n'),
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'Free-text search across title and author name.', { example: 'evaristo' }),
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
        param('sort', 'query', { type: 'string', enum: ['asc', 'desc'] },
          'Title sort. Omit to rank by relevance, which is what you want whenever `q` is set.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 },
          'Items to skip. **Ignored when `dedupe=true`** — use `cursor` there instead.'),
        param('dedupe', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Collapse same-titled editions to one. Off by default so every edition stays visible.'),
        param('shoppable', 'query', { type: 'string', enum: ['true', 'false'], default: 'false' },
          'Restrict to books the shop can list — an ISBN13, a live price, and no unsuppliable supplier report code. Out-of-stock titles are **kept**, each carrying `inStock` so you can badge them, because stock moves hourly and a book disappearing mid-browse reads as a bug. Not a guarantee of sellability: rights restrictions depend on a destination country this endpoint has none of, so they are enforced at add-to-cart instead.'),
        param('cursor', 'query', { type: 'string', maxLength: 4096 },
          'Opaque token from the previous response’s `nextCursor`. Only meaningful with `dedupe=true`; silently ignored otherwise.'),
      ],
      responses: {
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
      },
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
      ],
      responses: {
        200: json('Similar books, most similar first. May be empty.',
          object({ books: arrayOf(ref('BookSummary')) })),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
      },
    },
  },

  '/api/v1/authors/{slug}': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'One author',
      description: [
        'An author page, addressed by the slug of their name — `tayari-jones`, `n-k-jemisin`.',
        '',
        '**There is no authors table.** An author here is a distinct contributor name, so the slug *is* the identity. Build it from the displayed name by lowercasing, replacing every run of non-alphanumeric characters with a single hyphen, and trimming hyphens from both ends. Accents count as separators (`Adichié` → `adichi`), because the database index that resolves this cannot fold them.',
        '',
        'Scoped to primary authors (ONIX role A01) — an illustrator or translator does not get a page from that contribution. Two different people who share a name share one page; the catalogue holds nothing that could tell them apart.',
      ].join('\n'),
      parameters: [
        param('slug', 'path', { type: 'string', maxLength: 200 }, 'Slugified author name.',
          { example: 'tayari-jones' }),
      ],
      responses: {
        200: json('The author.', object({
          slug: { type: 'string', example: 'tayari-jones' },
          name: {
            type: 'string',
            description: 'The prevailing spelling, when several map to one slug.',
            example: 'Tayari Jones',
          },
          bookCount: { type: 'integer', example: 4 },
        })),
        400: json('Malformed slug.', ref('Error'), { error: 'Invalid author slug' }),
        404: json('No such author, or every one of their titles has been withdrawn.', ref('Error'),
          { error: 'Author not found' }),
      },
    },
  },

  '/api/v1/authors/{slug}/books': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'That author’s books',
      description: 'Newest first, undated titles last. Same book shape as every other list in the API.',
      parameters: [
        param('slug', 'path', { type: 'string', maxLength: 200 }, 'Slugified author name.',
          { example: 'tayari-jones' }),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page.'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of the author’s books.', object({
          books: arrayOf(ref('BookSummary')),
          total: { type: 'integer', example: 4 },
          hasMore: { type: 'boolean', example: false },
        })),
        400: resp('ValidationError'),
        404: json('No such author.', ref('Error'), { error: 'Author not found' }),
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
        '**Returns an empty `books` array when nothing sold in the window, and never substitutes another feed.** A discovery list presented as a sales chart would be indistinguishable from a real one and untrue. Hide the section when the array is empty rather than falling back to trending yourself.',
        '',
        'Identical for every caller — a factual ranking is not personalised, so nothing is filtered per viewer. Cached for an hour, cleared nightly.',
      ].join('\n'),
      parameters: [
        param('window', 'query', { type: 'string', enum: ['7d', '30d', '90d', 'all_time'], default: '30d' },
          'The sales window to rank over.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          'How many books (1–20).'),
      ],
      responses: {
        200: json('Bestsellers, or an empty list if nothing sold in the window.',
          object({
            window: { type: 'string', example: '30d' },
            source: {
              type: 'string',
              enum: ['orders'],
              description: 'Always `orders` — present so a future alternative source is distinguishable.',
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
