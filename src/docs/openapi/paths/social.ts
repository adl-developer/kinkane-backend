import {
  ref, resp, json, body, object, param, arrayOf, authErrors, plusErrors, successResponse,
} from '../helpers';

const COMMUNITY = 'Community';
const PEOPLE = 'People & Following';

const postIdParam = param('postId', 'path', { type: 'integer' }, 'Post id.', { example: 3310 });
const commentIdParam = param('commentId', 'path', { type: 'integer' }, 'Comment id.', { example: 771 });
const userIdParam = param('userId', 'path', { type: 'integer' }, 'The other user’s id.', { example: 4412 });

const listParams = [
  param('sort', 'query', { type: 'string', enum: ['date_desc', 'date_asc'], default: 'date_desc' },
    'Newest first by default.'),
  param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
  param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
];

const followParams = [
  param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
  param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
];

/**
 * The gating asymmetry across this whole surface, stated once here and
 * referenced from each operation: creating and editing need Plus, deleting and
 * unliking never do. A lapsed member keeps everything they made and can always
 * take it back down.
 */
const ASYMMETRY =
  'Note the gating asymmetry across Community: **create and edit require Plus, delete and unlike do not.** A member whose subscription lapses keeps what they posted and can always remove it — they just cannot add more.';

function postListResponse(description: string) {
  return json(description,
    object({
      posts: arrayOf(ref('Post')),
      total: { type: 'integer', example: 84 },
      sort: { type: 'string', example: 'date_desc' },
      limit: { type: 'integer', example: 20 },
      offset: { type: 'integer', example: 0 },
    }));
}

export const socialPaths = {
  // ── Posts ──────────────────────────────────────────────────────────────────

  '/api/v1/community/posts': {
    get: {
      tags: [COMMUNITY],
      summary: 'The community feed',
      description:
        'Posts visible to the caller — their own, plus public posts, plus follower-only posts by people whose follow request they have had accepted. Reading the feed is free.',
      parameters: listParams,
      responses: {
        200: postListResponse('A page of the feed.'),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },

    post: {
      tags: [COMMUNITY],
      summary: 'Post a rating or review',
      description: `Creates a post about a book. \`body\` is optional — a rating on its own is a perfectly valid post — but \`rating\`, \`status\` and \`isPublic\` are all required.\n\n**Requires Kinkané Plus.** ${ASYMMETRY}`,
      requestBody: body(object({
        bookId: { type: 'integer', minimum: 1, example: 48213 },
        rating: { type: 'integer', minimum: 0, maximum: 5, example: 5 },
        status: {
          type: 'string', enum: ['reading', 'read'],
          description: 'Where the author is in the book. `want_to_read` is not valid — there is nothing to review yet.',
          example: 'read',
        },
        body: {
          type: 'string', maxLength: 5000,
          description: 'The review text. Optional.',
          example: 'Twelve voices and not one wasted page.',
        },
        isPublic: {
          type: 'boolean',
          description: 'False restricts it to accepted followers.',
          example: true,
        },
      }, ['bookId', 'rating', 'status', 'isPublic'])),
      responses: {
        201: json('Post created.', ref('Post')),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        ...plusErrors,
      },
    },
  },

  '/api/v1/community/posts/mine': {
    get: {
      tags: [COMMUNITY],
      summary: 'The caller’s own posts',
      description: 'Every post the caller has written, public and follower-only alike. Free.',
      parameters: listParams,
      responses: {
        200: postListResponse('A page of the caller’s posts.'),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/community/books/{bookId}/posts': {
    get: {
      tags: [COMMUNITY],
      summary: 'Posts about one book',
      description:
        'Reviews of a single book, filtered to what the caller is allowed to see. This is what backs the reviews section on a book detail screen.',
      parameters: [
        param('bookId', 'path', { type: 'integer' }, 'Book id.', { example: 48213 }),
        ...listParams,
      ],
      responses: {
        200: postListResponse('A page of posts about this book.'),
        400: resp('ValidationError'),
        404: json('No book with that id.', ref('Error'), { error: 'Book not found' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/community/posts/{postId}': {
    get: {
      tags: [COMMUNITY],
      summary: 'Get one post',
      description:
        'A post the caller is allowed to see. A follower-only post belonging to someone they do not follow returns **404, not 403** — the existence of the post is itself private.',
      parameters: [postIdParam],
      responses: {
        200: json('The post.', ref('Post')),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },

    patch: {
      tags: [COMMUNITY],
      summary: 'Edit a post',
      description: `Patch semantics — only the fields present change. At least one must be supplied. Only the author can edit; anyone else gets a 404.\n\nPass \`body: null\` to strip the review text back to a bare rating.\n\n**Requires Kinkané Plus.** ${ASYMMETRY}`,
      parameters: [postIdParam],
      requestBody: body(object({
        rating: { type: 'integer', minimum: 0, maximum: 5, example: 4 },
        status: { type: 'string', enum: ['reading', 'read'], example: 'read' },
        body: { type: 'string', maxLength: 5000, nullable: true, example: 'Revisited it. Still extraordinary.' },
        isPublic: { type: 'boolean', example: true },
      })),
      responses: {
        200: successResponse,
        400: json('Validation failed, or no fields were supplied.', ref('ValidationError')),
        404: resp('NotFound'),
        ...plusErrors,
      },
    },

    delete: {
      tags: [COMMUNITY],
      summary: 'Delete a post',
      description: `Removes the post and its comments and likes. Author only.\n\n**Not gated** — a lapsed member must always be able to take down what they wrote.`,
      parameters: [postIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/community/posts/{postId}/like': {
    post: {
      tags: [COMMUNITY],
      summary: 'Like a post',
      description: `Idempotent. Sends a notification to the post’s author, subject to their \`likes\` notification preference.\n\n**Requires Kinkané Plus.**`,
      parameters: [postIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...plusErrors,
      },
    },

    delete: {
      tags: [COMMUNITY],
      summary: 'Unlike a post',
      description: 'Idempotent. **Not gated.**',
      parameters: [postIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  // ── Comments ───────────────────────────────────────────────────────────────

  '/api/v1/community/posts/{postId}/comments': {
    get: {
      tags: [COMMUNITY],
      summary: 'List a post’s comments',
      description: 'Oldest first. Free to read.',
      parameters: [
        postIdParam,
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of comments.',
          object({
            comments: arrayOf(ref('Comment')),
            total: { type: 'integer', example: 3 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },

    post: {
      tags: [COMMUNITY],
      summary: 'Comment on a post',
      description: `Notifies the post’s author, subject to their \`comments\` notification preference.\n\n**Requires Kinkané Plus.**`,
      parameters: [postIdParam],
      requestBody: body(object({
        body: { type: 'string', minLength: 1, maxLength: 2000, example: 'Adding it to my list right now.' },
      }, ['body'])),
      responses: {
        201: json('Comment created.', ref('Comment')),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...plusErrors,
      },
    },
  },

  '/api/v1/community/comments/{commentId}': {
    patch: {
      tags: [COMMUNITY],
      summary: 'Edit a comment',
      description: 'Author only. **Requires Kinkané Plus.**',
      parameters: [commentIdParam],
      requestBody: body(object({
        body: { type: 'string', minLength: 1, maxLength: 2000, example: 'Finished it — you were right.' },
      }, ['body'])),
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...plusErrors,
      },
    },

    delete: {
      tags: [COMMUNITY],
      summary: 'Delete a comment',
      description: 'Author only. **Not gated.**',
      parameters: [commentIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/community/comments/{commentId}/like': {
    post: {
      tags: [COMMUNITY],
      summary: 'Like a comment',
      description: 'Idempotent. **Requires Kinkané Plus.**',
      parameters: [commentIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...plusErrors,
      },
    },

    delete: {
      tags: [COMMUNITY],
      summary: 'Unlike a comment',
      description: 'Idempotent. **Not gated.**',
      parameters: [commentIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  // ── Search & friend detail ────────────────────────────────────────────────

  '/api/v1/community/search': {
    get: {
      tags: [COMMUNITY],
      summary: 'Search people and posts',
      description:
        'One query across both users and posts. `filter` narrows it; with `all`, both arrays come back and only the requested slice of each is populated. Results are scoped to what the caller is allowed to see.',
      parameters: [
        param('q', 'query', { type: 'string', minLength: 1, maxLength: 200 },
          'The search text. Trimmed; must be at least 1 character after trimming.',
          { required: true, example: 'evaristo' }),
        param('filter', 'query', { type: 'string', enum: ['all', 'users', 'posts'], default: 'all' },
          'Which kinds of result to include.'),
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('Search results.',
          object({
            users: arrayOf(ref('UserSummary')),
            posts: arrayOf(ref('Post')),
            total: { type: 'integer', example: 12 },
            filter: { type: 'string', example: 'all' },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/community/users/{friendId}/books/{bookId}': {
    get: {
      tags: [COMMUNITY],
      summary: 'See what a friend made of a book',
      description:
        'Another user’s shelf entry and post for one book — their status, whether they liked it, their note if it is public, and their review if there is one.\n\nSubject to that user’s `shelfVisibility` and the follow graph; a shelf the caller cannot see returns 403.',
      parameters: [
        param('friendId', 'path', { type: 'integer' }, 'The other user’s id.', { example: 4412 }),
        param('bookId', 'path', { type: 'integer' }, 'Book id.', { example: 48213 }),
      ],
      responses: {
        200: json('Their entry for this book.',
          object({
            user: ref('UserSummary'),
            book: ref('BookSummary'),
            status: { type: 'string', nullable: true, enum: ['want_to_read', 'reading', 'read', null], example: 'read' },
            liked: { type: 'boolean', example: true },
            note: {
              type: 'string', nullable: true,
              description: 'Only present when the note was marked public. Otherwise `null`.',
              example: 'Best thing I read this year.',
            },
            post: { allOf: [ref('Post')], nullable: true, description: 'Their review, if they wrote one.' },
          })),
        400: resp('ValidationError'),
        403: resp('Forbidden'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  // ── People & following ────────────────────────────────────────────────────

  '/api/v1/users/{userId}': {
    get: {
      tags: [PEOPLE],
      summary: 'Get another user’s profile',
      description:
        'A public profile plus the caller’s relationship to it. Check **`canViewShelf`** before rendering a shelf tab — it has already applied `shelfVisibility` and the follow graph, so you do not need to work it out client-side. `followState` tells you which button to show.',
      parameters: [userIdParam],
      responses: {
        200: json('The profile.', ref('UserProfile')),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/{userId}/books': {
    get: {
      tags: [PEOPLE],
      summary: 'Get another user’s shelf',
      description:
        'Their reading list, if they let the caller see it. Returns 403 when their `shelfVisibility` excludes the caller — check `canViewShelf` on the profile first and do not render the tab at all in that case.\n\nNotes appear only where the owner marked them public.',
      parameters: [
        userIdParam,
        param('filter', 'query',
          { type: 'string', enum: ['all', 'want_to_read', 'reading', 'read'], default: 'all' },
          'Reading state to show.'),
        param('sort', 'query',
          { type: 'string', enum: ['date_desc', 'date_asc', 'title_asc', 'title_desc'], default: 'date_desc' },
          'Sort order.'),
        ...followParams,
      ],
      responses: {
        200: json('A page of their shelf.',
          object({
            books: arrayOf(ref('UserBookEntry')),
            total: { type: 'integer', example: 37 },
            filter: { type: 'string', example: 'all' },
            sort: { type: 'string', example: 'date_desc' },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        403: resp('Forbidden'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/{userId}/follow': {
    post: {
      tags: [PEOPLE],
      summary: 'Send a follow request',
      description:
        'Following is **request-and-accept**, not instant: this creates a pending request the other user resolves from `GET /users/follow-requests`. A 409 means a request is already pending or the caller already follows them.\n\n**Rate limit:** 30 per hour.',
      parameters: [userIdParam],
      responses: {
        201: successResponse,
        400: json('Invalid id, or an attempt to follow oneself.', ref('ValidationError')),
        404: resp('NotFound'),
        409: json('Already following, or a request is already pending.', ref('Error'),
          { error: 'Follow request already exists' }),
        ...authErrors,
      },
    },

    delete: {
      tags: [PEOPLE],
      summary: 'Withdraw a follow request, or unfollow',
      description:
        'Cancels a pending request, or stops following if it was already accepted — one endpoint for both, since from the caller’s side it is the same intent. Idempotent.',
      parameters: [userIdParam],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/{userId}/followers': {
    get: {
      tags: [PEOPLE],
      summary: 'List a user’s followers',
      description: 'Accepted followers only — pending requests are not included.',
      parameters: [userIdParam, ...followParams],
      responses: {
        200: json('A page of followers.',
          object({
            users: arrayOf(ref('UserSummary')),
            total: { type: 'integer', example: 128 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/{userId}/following': {
    get: {
      tags: [PEOPLE],
      summary: 'List who a user follows',
      description: 'Accepted follows only.',
      parameters: [userIdParam, ...followParams],
      responses: {
        200: json('A page of followed users.',
          object({
            users: arrayOf(ref('UserSummary')),
            total: { type: 'integer', example: 94 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/follow-requests': {
    get: {
      tags: [PEOPLE],
      summary: 'List incoming follow requests',
      description:
        'Requests awaiting the caller’s decision. Each carries a **`requestId`** — that is what the accept and decline endpoints take, not the user id.',
      parameters: followParams,
      responses: {
        200: json('A page of pending requests.',
          object({
            requests: arrayOf(ref('FollowRequest')),
            total: { type: 'integer', example: 2 },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/follow-requests/{requestId}/accept': {
    patch: {
      tags: [PEOPLE],
      summary: 'Accept a follow request',
      description:
        'The requester becomes a follower and gains access to follower-only posts and, if `shelfVisibility` is `friends`, the shelf. Only the recipient can accept; anyone else gets a 404.',
      parameters: [param('requestId', 'path', { type: 'integer' },
        'From `GET /users/follow-requests` — the request id, not the user id.', { example: 902 })],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  '/api/v1/users/follow-requests/{requestId}/decline': {
    patch: {
      tags: [PEOPLE],
      summary: 'Decline a follow request',
      description: 'The requester is not notified that they were declined. They may request again.',
      parameters: [param('requestId', 'path', { type: 'integer' }, 'The request id.', { example: 902 })],
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        404: resp('NotFound'),
        ...authErrors,
      },
    },
  },

  // ── Reports ────────────────────────────────────────────────────────────────

  '/api/v1/reports': {
    post: {
      tags: [PEOPLE],
      summary: 'Report a user',
      description:
        'Files a moderation report against another user, optionally citing the post that prompted it.\n\nIf `postId` is given it must actually belong to `reportedUserId` — a mismatch is a 400 rather than a silently mis-filed report. Self-reports are rejected.',
      requestBody: body(object({
        reportedUserId: { type: 'integer', minimum: 1, example: 4412 },
        reason: { type: 'string', minLength: 1, maxLength: 2000, example: 'Harassment in the comments.' },
        postId: {
          type: 'integer', minimum: 1,
          description: 'The post being reported about. Must belong to `reportedUserId`.',
          example: 3310,
        },
      }, ['reportedUserId', 'reason'])),
      responses: {
        201: json('Report filed.',
          object({
            report: object({
              id: { type: 'integer', example: 44 },
              reportedUserId: { type: 'integer', example: 4412 },
              postId: { type: 'integer', nullable: true, example: 3310 },
              reason: { type: 'string', example: 'Harassment in the comments.' },
              createdAt: { type: 'string', format: 'date-time', example: '2026-08-13T11:00:00.000Z' },
            }),
          })),
        400: json('Validation failed, a self-report, or the post does not belong to that user.',
          ref('ValidationError')),
        404: json('No such user or post.', ref('Error'), { error: 'User not found' }),
        ...authErrors,
      },
    },
  },
};
