import {
  ref, resp, json, body, object, param, arrayOf, authErrors, plusErrors, successResponse,
} from '../helpers';

const TAG = 'Library';

const bookIdParam = param('bookId', 'path', { type: 'integer' },
  'Kinkané book id.', { example: 48213 });

/**
 * The read/write asymmetry documented all over this file is a deliberate
 * product decision ("retain, read-only"), not an oversight: a member whose
 * subscription lapses keeps everything they built and can still tidy it up —
 * they just cannot add more. Adding a Plus gate to a delete here would take
 * away a user's ability to clean up their own data.
 */
const RETAIN_READ_ONLY =
  'Free for every signed-in user, including lapsed members — the "retain, read-only" rule. Building the shelf needs Plus; reading it and clearing it never do.';

export const libraryPaths = {
  '/api/v1/user-books': {
    get: {
      tags: [TAG],
      summary: 'List the shelf',
      description: `The caller’s own reading list, with filtering, search and sorting.\n\n${RETAIN_READ_ONLY}`,
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'Search the shelf by book title.', { example: 'girl' }),
        param('status', 'query', { type: 'string', enum: ['want_to_read', 'reading', 'read'] },
          'Show only entries in this reading state. Omit for all.'),
        param('liked', 'query', { type: 'string', enum: ['true', 'false'] },
          'Filter to liked (or explicitly not-liked) entries. Omit for all.'),
        param('sort', 'query',
          { type: 'string', enum: ['title_asc', 'title_desc', 'date_asc', 'date_desc'], default: 'date_desc' },
          '`date_*` sorts by when the book was added to the shelf.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of the shelf.',
          object({
            books: arrayOf(ref('UserBookEntry')),
            total: { type: 'integer', example: 37 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user-books/{bookId}': {
    put: {
      tags: [TAG],
      summary: 'Add a book to the shelf, or update its entry',
      description: [
        'One endpoint for both add and edit — there is no separate create call.',
        '',
        '- **First call for a book**: inserts the entry, filling sensible defaults for anything omitted.',
        '- **Later calls**: patch semantics. Only the fields present in the body change; the rest are left alone.',
        '',
        'At least one field must be supplied — an empty body is a 400 rather than a no-op.',
        '',
        '**Requires Kinkané Plus** (building the shelf is the gated part; see `DELETE` on this path, which is not gated).',
      ].join('\n'),
      parameters: [bookIdParam],
      requestBody: body(object({
        status: {
          type: 'string', enum: ['want_to_read', 'reading', 'read'],
          description: 'The reading state.', example: 'reading',
        },
        note: {
          type: 'string', maxLength: 1000, nullable: true,
          description: 'A private note. Pass `null` to clear it.',
          example: 'Lent to Ama — get it back!',
        },
        noteIsPublic: {
          type: 'boolean',
          description: 'When true, the note is visible to anyone who can see this shelf.',
          example: false,
        },
        liked: { type: 'boolean', description: 'Equivalent to the like/unlike endpoints below.', example: true },
      })),
      responses: {
        200: json('The entry as it now stands.', ref('UserBookEntry')),
        400: json('Validation failed, or no fields were supplied.', ref('ValidationError')),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        ...plusErrors,
      },
    },

    delete: {
      tags: [TAG],
      summary: 'Remove a book from the shelf',
      description: `Deletes the entry outright, including any note and the liked flag. Idempotent.\n\n${RETAIN_READ_ONLY}`,
      parameters: [bookIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user-books/{bookId}/like': {
    post: {
      tags: [TAG],
      summary: 'Like a book',
      description:
        'Idempotent. Creates a shelf entry if the book is not on the shelf yet — one with no reading status, just the liked flag, which is why `status` is nullable on `UserBookEntry`.\n\n**Requires Kinkané Plus.**',
      parameters: [bookIdParam],
      responses: {
        200: successResponse,
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        ...plusErrors,
      },
    },

    delete: {
      tags: [TAG],
      summary: 'Unlike a book',
      description: `Clears the liked flag. If the entry exists **only** because of the like — no reading status — the whole entry is removed rather than left as an empty row.\n\n${RETAIN_READ_ONLY}`,
      parameters: [bookIdParam],
      responses: {
        200: successResponse,
        ...authErrors,
      },
    },
  },

  '/api/v1/user-books/reset': {
    post: {
      tags: [TAG],
      summary: 'Clear the entire shelf',
      description: [
        '**Irreversible.** Deletes every entry on the caller’s shelf.',
        '',
        'Confirmed with a credential, and exactly one of the two must be sent — supplying both, or neither, is a 400:',
        '- `password` — for email/password accounts.',
        '- `idToken` — a fresh Firebase ID token, for social accounts, which have no password to check.',
        '',
        `${RETAIN_READ_ONLY}`,
      ].join('\n'),
      requestBody: body(object({
        password: { type: 'string', description: 'For password accounts.', example: 'Correct-Horse9' },
        idToken: { type: 'string', description: 'For social accounts. A current Firebase ID token.' },
      })),
      responses: {
        200: json('Shelf cleared.',
          object({ deleted: { type: 'integer', description: 'How many entries were removed.', example: 37 } }),
          { deleted: 37 }),
        400: json('Neither credential supplied, or both were.', ref('Error'),
          { error: 'Provide either password or idToken, not both and not neither' }),
        401: json('The password or token is wrong.', ref('Error'), { error: 'Incorrect password' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/preference-history': {
    get: {
      tags: [TAG],
      summary: 'The taste profile over time',
      description:
        'The caller’s preference timeline, newest first. Each entry is a full snapshot of their taste profile at that moment, plus `changedFields` naming what differed from the entry before it.\n\nStrictly self-scoped — there is no path to anyone else’s history.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          'Items per page (1–100 here, unlike the 50 used elsewhere).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of history.',
          object({
            preferenceHistory: arrayOf(object({
              id: { type: 'integer', example: 88 },
              feelings: { type: 'array', items: { type: 'string' }, example: ['hopeful', 'curious', 'calm'] },
              genres: { type: 'array', items: { type: 'string' }, example: ['poetry', 'classics', 'travel'] },
              dislikes: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              bookIds: { type: 'array', items: { type: 'integer' }, example: [48213] },
              readerType: { type: 'string', nullable: true, example: 'The Wanderer' },
              changedFields: {
                type: 'array', items: { type: 'string' },
                description: 'What differed from the previous snapshot. Empty on the first entry.',
                example: ['genres', 'dislikes'],
              },
              source: {
                type: 'string',
                description: 'What produced this snapshot — onboarding, a quiz retake, a selections save.',
                example: 'quiz_retake',
              },
              recordedAt: { type: 'string', format: 'date-time', example: '2026-08-02T14:00:00.000Z' },
            })),
            pagination: ref('Pagination'),
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },
};
