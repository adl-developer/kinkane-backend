/**
 * Shared OpenAPI components — security schemes, reusable error responses, and
 * the object shapes that appear in more than one endpoint's response.
 *
 * Everything here is referenced with `$ref` from the path modules rather than
 * repeated. A schema defined once and referenced 20 times is 20 places that
 * cannot drift apart, and Swagger UI renders the model expander for it.
 *
 * `example` values throughout are deliberately realistic rather than
 * placeholder — an integrator reading `"9780241988268"` learns the ISBN field
 * is a 13-digit string with no hyphens, which `"string"` does not tell them.
 */

export const securitySchemes = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: [
      'The access token returned by any of the sign-in endpoints, sent as',
      '`Authorization: Bearer <accessToken>`.',
      '',
      '**Lifetime:** 15 minutes by default (`ACCESS_TOKEN_TTL`). When fewer than',
      '5 minutes remain, any authenticated response carries a replacement token in',
      'the `X-New-Access-Token` header — read that header on every response and',
      'swap it in when present, and most clients never see a 401 at all.',
      '',
      'When the token has fully expired, call `POST /api/v1/auth/refresh` with the',
      'refresh token. Refresh tokens are single-use: the response returns a new',
      'one, and the token you submitted is deleted immediately. Store the new one',
      'or the next refresh will fail.',
      '',
      '**To authorise this page:** sign in via `POST /api/v1/auth/login` below,',
      'copy `accessToken` from the response, then click **Authorize** at the top',
      'right and paste it in. Every subsequent "Try it out" will send it.',
    ].join('\n'),
  },
} as const;

// ── Error shapes ──────────────────────────────────────────────────────────────
// The API has two distinct error bodies and it matters which one you get:
// `error` is a string for anything the server decided, and an object of
// field -> messages for anything Zod rejected. A client that assumes a string
// will render "[object Object]" to a user on the first bad form submission.

const errorSchemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'string',
        description: 'Human-readable description of what went wrong.',
        example: 'Book not found',
      },
      code: {
        type: 'string',
        description:
          'Stable machine-readable code, present on the errors a client is expected to branch on (e.g. `PLUS_REQUIRED`, `OUT_OF_STOCK`, `CART_CHANGED`). Branch on this, never on the `error` text.',
        example: 'OUT_OF_STOCK',
      },
    },
  },

  ValidationError: {
    type: 'object',
    required: ['error'],
    description:
      'Returned when request validation fails. `error` is an object keyed by the offending field name, each mapping to an array of messages — not a string. Endpoints that reject a request for a non-validation reason return the plain `Error` shape instead.',
    properties: {
      error: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        example: {
          email: ['Invalid email address'],
          password: ['Password must contain at least one number'],
        },
      },
    },
  },

  PlusRequired: {
    type: 'object',
    required: ['error', 'code'],
    description:
      'Returned with HTTP **402** by every Kinkané Plus-gated endpoint. 402 rather than 403 on purpose: the client has to tell "you need to subscribe" apart from "this is not yours" without parsing prose. Key the paywall off `code`.',
    properties: {
      error: { type: 'string', example: 'Kinkané Plus is required for this feature' },
      code: { type: 'string', enum: ['PLUS_REQUIRED'], example: 'PLUS_REQUIRED' },
      tier: { type: 'string', example: 'free' },
      status: { type: 'string', example: 'expired' },
      upgradeUrl: {
        type: 'string',
        format: 'uri',
        example: 'https://kinkane.app/redirect/account/subscription',
      },
    },
  },
} as const;

// ── Domain objects ────────────────────────────────────────────────────────────

const bookSchemas = {
  Contributor: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'Bernardine Evaristo' },
      role: {
        type: 'string',
        description: 'ONIX contributor role — `A01` is author, `B06` translator, and so on.',
        example: 'A01',
      },
    },
  },

  Genre: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 7 },
      name: { type: 'string', example: 'Literary studies', description: 'Top-level name only — the part of the stored heading before the first colon.' },
      slug: { type: 'string', example: 'literary_studies', description: 'Top-level slug. Passed to `?genre=`, it matches every genre under that top level.' },
    },
  },

  BookSummary: {
    type: 'object',
    description:
      'The compact book shape used by every list, search and discovery endpoint. Enough to render a cover card; call `GET /books/{id}` for the full record.',
    properties: {
      id: { type: 'integer', example: 48213 },
      title: { type: 'string', example: 'Girl, Woman, Other' },
      coverUrl: {
        type: 'string',
        format: 'uri',
        nullable: true,
        example: 'https://images.kinkane.app/covers/9780241988268.jpg',
      },
      isbn13: { type: 'string', nullable: true, example: '9780241988268' },
      publicationDate: { type: 'string', format: 'date', nullable: true, example: '2019-05-02' },
      contributors: { type: 'array', items: { $ref: '#/components/schemas/Contributor' } },
      genres: {
        type: 'array',
        items: { $ref: '#/components/schemas/Genre' },
        description:
          'Top-level genre names only: a stored heading like "Literary studies: poetry and poets" is shown as "Literary studies", and a top level that several of the book\'s genres share appears once. `slug` is the top-level slug, the same one `GET /genres` lists, so passing it to `?genre=` filters by the whole top level.',
      },
      unitPriceMinor: {
        type: 'integer',
        description: 'The live sellable price, in `currency`. Present only with `shoppable=true`. **This — not the `prices` array — is what the shop charges.** That array is ONIX edition metadata and disagrees with the supplier feed on part of the catalogue, so rendering it shows a price the basket will not honour. It is also what `priceMin`/`priceMax` filter on, so a filtered page can display the number it was filtered by.',
        example: 1307,
      },
      compareAtMinor: {
        type: 'integer', nullable: true,
        description: 'Pre-markdown price when a promotion is running, for striking through. Null when not on sale.',
        example: null,
      },
      currency: {
        type: 'string',
        description: 'Always `GBP`: prices are passed through exactly as Gardners supplies them, never converted.',
        example: 'GBP',
      },
      inStock: {
        type: 'boolean',
        example: true,
        description:
          'Present on `GET /books?shoppable=true` for rows with `shoppable: true`. Whether the supplier currently has stock. `false` means list it with an out-of-stock badge, not hide it. Absent on unsellable rows and on every other endpoint — do not treat a missing value as out of stock.',
      },
      availableQuantity: {
        type: 'integer',
        minimum: 0,
        example: 3,
        description:
          'How many copies one customer can buy right now. Present on every row of `GET /books` (with or without `shoppable`), on `GET /books/:id` and its `otherEditions`, on every discovery feed, on reading shelves and on saved books. Use it to cap the quantity stepper and for "only N left", and treat it as the answer to "can this be added": `shoppable: true, inStock: false` includes titles that are simply out of stock, which carry `0` here. A withdrawn title is always `0`. It follows the cart\'s own rules, so the basket will accept any quantity up to it: in-stock titles give their stock, capped at the per-line maximum (10 by default); extended-catalogue and print-on-demand titles give the per-line maximum even though they have no shelf stock; anything that cannot be bought (no price, cannot be supplied, out of stock, not stocked by the supplier) gives `0`. Always capped, never the supplier\'s raw stock. Rights restrictions depend on the delivery country and are still checked at add-to-cart.',
      },
      shoppable: {
        type: 'boolean',
        example: true,
        description:
          'Present only on `GET /books?shoppable=true`. Whether the shop can sell this book at all — it has an ISBN13, a live supplier price, and no unsuppliable report code. `shoppable=true` excludes unsellable books, so this is `true` on every row you receive; it is kept for clients that already read it. If a row ever says `false`, give it no Add button — the other shop fields (`inStock`, `unitPriceMinor`, `compareAtMinor`, `currency`) are omitted on such a row. Absent on every other endpoint.',
      },
    },
  },

  BookCard: {
    allOf: [
      { $ref: '#/components/schemas/BookSummary' },
      {
        type: 'object',
        description: 'A BookSummary as listings return it: with the caller\'s own rating and review attached.',
        properties: {
          myReview: { $ref: '#/components/schemas/MyReview' },
        },
      },
    ],
  },

  MyReview: {
    type: 'object',
    nullable: true,
    description:
      "The caller's own rating and review of this book — their community post for it, private ones included. `null` when they have not reviewed this exact edition, and always `null` for anonymous callers. Matched by book id, not by work: a review of the paperback does not appear on the hardback. Edit or delete it through `/community/posts/{postId}`.\n\n**Where it sits:** on each book in lists, search, discovery feeds, recommendations, shelves and saved books; on the nested `book` card of group shelf entries; and at the **top level** of the response (beside `book`, not inside it) on `GET /books/{id}` and the friend's-book page.",
    properties: {
      postId: { type: 'integer', example: 3121 },
      rating: { type: 'integer', minimum: 0, maximum: 5, example: 4 },
      status: { type: 'string', enum: ['reading', 'read'], example: 'read' },
      body: { type: 'string', nullable: true, example: 'Twelve voices and not one wasted.' },
      isPublic: { type: 'boolean', example: true },
      createdAt: { type: 'string', format: 'date-time', example: '2026-09-21T19:04:00.000Z' },
      updatedAt: { type: 'string', format: 'date-time', example: '2026-09-21T19:04:00.000Z' },
    },
  },

  BookDetail: {
    allOf: [
      { $ref: '#/components/schemas/BookSummary' },
      {
        type: 'object',
        description: 'The full catalogue record, as returned by `GET /books/{id}`.',
        properties: {
          subtitle: { type: 'string', nullable: true, example: null },
          description: {
            type: 'string',
            nullable: true,
            description: 'Publisher long description. May contain light HTML.',
            example: 'Booker Prize-winning novel following twelve characters…',
          },
          publisher: { type: 'string', nullable: true, example: 'Penguin' },
          productForm: {
            type: 'string',
            nullable: true,
            description: 'ONIX product form — `BC` paperback, `BB` hardback, `AJ` audio.',
            example: 'BC',
          },
          productFormLabel: {
            type: 'string',
            nullable: true,
            description: 'Human-readable label for productForm (ONIX List 150).',
            example: 'Paperback or softback book',
          },
          otherEditions: {
            type: 'array',
            description:
              'Other editions of this same title (matched on exact title and a shared contributor — ' +
              'a heuristic, since the supplier feed carries no explicit link between editions). ' +
              'Publisher is not compared, so adjacent editions of the same work can appear, not ' +
              'strictly format variants. Capped at 20. Empty when none are found.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', example: 5821 },
                isbn13: { type: 'string', nullable: true, example: '9780241988275' },
                productForm: { type: 'string', nullable: true, example: 'BB' },
                productFormLabel: { type: 'string', nullable: true, example: 'Hardback or cased book' },
                coverUrl: { type: 'string', nullable: true, format: 'uri' },
                publicationDate: { type: 'string', nullable: true, format: 'date', example: '2019-08-15' },
              },
            },
          },
          publishingStatus: {
            type: 'string',
            nullable: true,
            description: 'ONIX publishing status — `04` is active.',
            example: '04',
          },
          availability: {
            type: 'string',
            nullable: true,
            description: 'ONIX availability code — `21` in stock, `31` out of stock.',
            example: '21',
          },
          pageCount: { type: 'integer', nullable: true, example: 464 },
          language: { type: 'string', nullable: true, example: 'eng' },
          subjects: { type: 'array', items: { type: 'string' }, example: ['Fiction', 'Feminism'] },
          prices: {
            type: 'array',
            description: 'Supplier prices, in the currency each was quoted in.',
            items: {
              type: 'object',
              properties: {
                amount: { type: 'string', example: '9.99' },
                currency: { type: 'string', example: 'GBP' },
                priceType: { type: 'string', nullable: true, example: '02' },
              },
            },
          },
        },
      },
    ],
  },

  UserStatus: {
    type: 'object',
    nullable: true,
    description:
      "The caller's own shelf entry for this book. Populated only when a valid access token is sent — `null` for anonymous callers and for books the caller has no entry for.",
    properties: {
      status: {
        type: 'string',
        nullable: true,
        enum: ['want_to_read', 'reading', 'read', null],
        example: 'reading',
      },
      liked: { type: 'boolean', example: true },
      note: { type: 'string', nullable: true, example: 'Lent to Ama' },
      noteIsPublic: { type: 'boolean', example: false },
    },
  },

  UserBookEntry: {
    type: 'object',
    description: "One entry on a user's shelf: the book plus what that user did with it.",
    properties: {
      book: { $ref: '#/components/schemas/BookSummary' },
      status: {
        type: 'string',
        nullable: true,
        enum: ['want_to_read', 'reading', 'read', null],
        description: 'Null when the entry exists only because the book was liked.',
        example: 'read',
      },
      liked: { type: 'boolean', example: true },
      note: { type: 'string', nullable: true, example: 'Best thing I read this year.' },
      noteIsPublic: {
        type: 'boolean',
        description: 'When true, the note is shown to anyone who can see this shelf.',
        example: true,
      },
      addedAt: { type: 'string', format: 'date-time', example: '2026-03-04T18:22:11.000Z' },
      myReview: { $ref: '#/components/schemas/MyReview' },
    },
  },
} as const;

const socialSchemas = {
  MentionRef: {
    type: 'object',
    description:
      'One linked @handle inside a piece of user-written text — a post, comment, group description, shelf description, group discussion comment or shelf note. The text itself already reads `@username`; this says where, so the client can make that span tappable.\n\n' +
      '`start` and `length` are in **UTF-16 code units** (JavaScript string indices; also how Dart `String` and Swift `NSString`/`NSRange` index), and `length` includes the `@`. `username` is always the account’s *current* username — mentions are stored by account id, so a rename never breaks one. A mention of a deleted account reads `@deleted` and has no entry here.\n\n' +
      'Clients send plain text with `@username` in it and get plain text back; there is nothing to encode. Editing round-trips: send back exactly what you were shown.',
    properties: {
      userId: { type: 'integer', example: 4412 },
      username: { type: 'string', example: 'ama_reads' },
      start: { type: 'integer', example: 22 },
      length: { type: 'integer', example: 10 },
    },
  },

  MentionFeedItem: {
    type: 'object',
    description: 'One place the caller was @-mentioned, as `GET /user/mentions` returns it.',
    properties: {
      id: { type: 'integer', example: 9031 },
      sourceType: {
        type: 'string',
        enum: ['post', 'comment', 'group', 'group_book', 'group_comment', 'book_note'],
        description:
          '`post` a review; `comment` a comment on one; `group` a group description; `group_book` the description on a group’s shelf entry; `group_comment` a group discussion comment or reply; `book_note` a public shelf note.',
        example: 'comment',
      },
      createdAt: { type: 'string', format: 'date-time' },
      author: { allOf: [{ $ref: '#/components/schemas/UserSummary' }], nullable: true, description: 'Null if their account has been deleted.' },
      excerpt: {
        type: 'string', nullable: true,
        description: 'The first 140 characters of the text, rendered. Null when `restricted`.',
        example: 'You have to read this, @ama_reads — the ending!',
      },
      mentions: { type: 'array', items: { $ref: '#/components/schemas/MentionRef' }, description: 'Linked handles within `excerpt`.' },
      restricted: {
        type: 'boolean',
        description:
          'True when the caller cannot read the text: it is in a private group they are not in, or its author has since made it private. The entry keeps its place in the list; only the excerpt is withheld.',
        example: false,
      },
      target: {
        type: 'object',
        description:
          'Where to navigate. Only the keys that apply are present: `postId`, `commentId`, `groupId`, `groupName`, `groupBookId`, `groupCommentId`, `parentCommentId` (for a reply), `bookId`, `bookTitle`. When `restricted`, comment ids are left out.',
        example: { postId: 3310, commentId: 771, bookId: 48213, bookTitle: 'Girl, Woman, Other' },
      },
    },
  },

  UserSummary: {
    type: 'object',
    description: 'The public face of an account, as it appears in lists and on posts.',
    properties: {
      id: { type: 'integer', example: 4412 },
      name: { type: 'string', example: 'Ama Boateng' },
      username: {
        type: 'string', nullable: true,
        description: 'The @handle, without the `@`. Lowercase `a-z 0-9 _ .`, 3–20 characters. Null only for web-shop guest accounts.',
        example: 'ama_reads',
      },
      photoUrl: {
        type: 'string',
        format: 'uri',
        nullable: true,
        example: 'https://res.cloudinary.com/kinkane/image/upload/v1/avatars/4412.jpg',
      },
    },
  },

  UserProfile: {
    allOf: [
      { $ref: '#/components/schemas/UserSummary' },
      {
        type: 'object',
        properties: {
          joinedYear: { type: 'integer', example: 2026 },
          readerType: {
            type: 'string',
            nullable: true,
            description: 'Inferred taste label from onboarding, e.g. "The Wanderer".',
            example: 'The Wanderer',
          },
          shelfVisibility: {
            type: 'string',
            enum: ['public', 'friends', 'private'],
            example: 'friends',
          },
          canViewShelf: {
            type: 'boolean',
            description:
              "Whether the *caller* may read this user's shelf, having applied `shelfVisibility` and the follow graph. When false, `GET /users/{userId}/books` returns 403.",
            example: true,
          },
          followState: {
            type: 'string',
            enum: ['none', 'pending', 'following', 'self'],
            description: "The caller's relationship to this user.",
            example: 'following',
          },
          incomingFollowRequest: {
            type: 'object',
            nullable: true,
            description:
              'A pending follow request this user has sent the *caller*. When set, show Accept/Decline (with `requestId`) instead of a Follow button — `POST /users/{userId}/follow` is refused with a 409 while it is pending.',
            properties: {
              requestId: { type: 'integer', example: 902 },
              requestedAt: { type: 'string', format: 'date-time', example: '2026-09-28T20:48:04.353Z' },
            },
          },
          followerCount: { type: 'integer', example: 128 },
          followingCount: { type: 'integer', example: 94 },
          bookCount: { type: 'integer', example: 37 },
        },
      },
    ],
  },

  FollowRequest: {
    type: 'object',
    properties: {
      requestId: {
        type: 'integer',
        description: 'Pass this to the accept/decline endpoints — not the user id.',
        example: 902,
      },
      user: { $ref: '#/components/schemas/UserSummary' },
      requestedAt: { type: 'string', format: 'date-time', example: '2026-08-11T09:15:00.000Z' },
    },
  },

  Post: {
    type: 'object',
    description: 'A rating and optional review of a book.',
    properties: {
      id: { type: 'integer', example: 3310 },
      author: { $ref: '#/components/schemas/UserSummary' },
      book: { $ref: '#/components/schemas/BookSummary' },
      rating: { type: 'integer', minimum: 0, maximum: 5, example: 5 },
      status: {
        type: 'string',
        enum: ['reading', 'read'],
        description: 'Where the author was in the book when they posted.',
        example: 'read',
      },
      body: {
        type: 'string',
        nullable: true,
        description: 'The review text. Optional — a rating on its own is a valid post. May contain @mentions; see `mentions`.',
        example: 'Twelve voices and not one wasted page.',
      },
      mentions: { type: 'array', items: { $ref: '#/components/schemas/MentionRef' }, description: 'Linked @handles in `body`. Empty when there are none.' },
      isPublic: {
        type: 'boolean',
        description: 'False restricts the post to the author’s accepted followers.',
        example: true,
      },
      likeCount: { type: 'integer', example: 24 },
      commentCount: { type: 'integer', example: 3 },
      likedByMe: { type: 'boolean', example: false },
      createdAt: { type: 'string', format: 'date-time', example: '2026-07-30T20:04:00.000Z' },
      updatedAt: { type: 'string', format: 'date-time', example: '2026-07-30T20:04:00.000Z' },
    },
  },

  BookReview: {
    type: 'object',
    description:
      'One reader’s rating and review of a book, as `GET /books/{id}/reviews` returns it. Flat: the reviewer and book are plain fields, not nested objects.',
    properties: {
      id: { type: 'integer', example: 3310, description: 'The post id — what the community edit/delete/like routes take.' },
      userId: { type: 'integer', example: 4412 },
      userName: { type: 'string', example: 'Ama Boateng' },
      userUsername: { type: 'string', nullable: true, example: 'ama_reads' },
      userPhotoUrl: { type: 'string', format: 'uri', nullable: true, example: null },
      bookId: { type: 'integer', example: 48213 },
      bookTitle: { type: 'string', example: 'Girl, Woman, Other' },
      bookCoverUrl: { type: 'string', format: 'uri', nullable: true, example: null },
      bookExcerpt: {
        type: 'object',
        nullable: true,
        properties: {
          title: { type: 'string', nullable: true },
          url: { type: 'string', nullable: true },
          available: { type: 'boolean' },
        },
      },
      rating: { type: 'integer', minimum: 0, maximum: 5, example: 5 },
      status: { type: 'string', enum: ['reading', 'read'], example: 'read' },
      body: { type: 'string', nullable: true, example: 'Twelve voices and not one wasted page.' },
      mentions: { type: 'array', items: { $ref: '#/components/schemas/MentionRef' }, description: 'Linked @handles in `body`. Empty when there are none.' },
      isPublic: {
        type: 'boolean',
        example: true,
        description: 'Always true on other people’s reviews; can be false only on your own.',
      },
      likeCount: { type: 'integer', example: 24 },
      commentCount: { type: 'integer', example: 3 },
      likedByMe: { type: 'boolean', example: false },
      isMine: { type: 'boolean', example: false, description: 'True on the caller’s own review.' },
      createdAt: { type: 'string', format: 'date-time', example: '2026-07-30T20:04:00.000Z' },
      updatedAt: { type: 'string', format: 'date-time', example: '2026-07-30T20:04:00.000Z' },
    },
  },

  Comment: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 771 },
      postId: { type: 'integer', example: 3310 },
      author: { $ref: '#/components/schemas/UserSummary' },
      body: { type: 'string', example: 'Adding it to my list right now, @kofi.reads.' },
      mentions: { type: 'array', items: { $ref: '#/components/schemas/MentionRef' }, description: 'Linked @handles in `body`. Empty when there are none.' },
      likeCount: { type: 'integer', example: 2 },
      likedByMe: { type: 'boolean', example: false },
      createdAt: { type: 'string', format: 'date-time', example: '2026-07-30T21:10:00.000Z' },
    },
  },

  Notification: {
    type: 'object',
    description:
      'One item in the notifications feed. Every kind is a stored row, so `id` is always an integer and any item can be marked read or cleared.\n\n' +
      '`friend_request` goes to the person a follow request was sent *to*; its `data` carries `followRequestId` (what the accept/decline endpoints take), `senderId`, `senderName`, `senderPhotoUrl` and `status` (`pending`, `accepted` or `declined`). Status, name and photo are always current. Accepting or declining also marks it read; a re-sent request moves it back to the top as unread; a withdrawn request removes it.\n\n' +
      '`follow_accepted` goes to the person whose request was accepted; its `data` carries `followRequestId`, `accepterId`, `accepterName` and `accepterPhotoUrl`. `new_recommendation` carries `bookId`, `bookTitle`, `bookAuthor` and `bookCoverUrl`.\n\n' +
      '`mention` — someone @-mentioned you. `data` carries `sourceType` (as on MentionFeedItem), the navigation ids that apply (`postId`, `commentId`, `groupId`, `groupName`, `groupBookId`, `groupCommentId`, `parentCommentId`, `bookId`, `bookTitle`), `mentionerId`, `mentionerName`, `mentionerUsername`, `mentionerPhotoUrl`, `excerpt` with `excerptMentions`, and `restricted`. When `restricted` is true you were mentioned in a private group you are not in: `excerpt` is null and comment ids are omitted. Mentions in a private post or private note are not notified until it is made public.',
    properties: {
      id: { type: 'integer', example: 5521 },
      type: {
        type: 'string',
        enum: ['post_like', 'post_comment', 'group_invite', 'follow_accepted', 'new_recommendation', 'friend_request', 'mention'],
        example: 'post_comment',
      },
      actor: { $ref: '#/components/schemas/UserSummary' },
      postId: { type: 'integer', nullable: true, example: 3310 },
      read: { type: 'boolean', example: false },
      createdAt: { type: 'string', format: 'date-time', example: '2026-08-13T07:45:00.000Z' },
    },
  },
} as const;

const commerceSchemas = {
  CartLine: {
    type: 'object',
    description:
      'One line of the cart, re-priced against the live Gardners feed on every read. The flags are the point: show them before letting the user check out, or checkout will 409.',
    properties: {
      bookId: { type: 'integer', example: 48213 },
      title: { type: 'string', example: 'Girl, Woman, Other' },
      coverUrl: { type: 'string', format: 'uri', nullable: true },
      quantity: { type: 'integer', example: 2 },
      unitPriceMinor: {
        type: 'integer',
        description: 'Unit price in the smallest unit of `currency` (cents/pence).',
        example: 1299,
      },
      lineTotalMinor: { type: 'integer', example: 2598 },
      compareAtMinor: {
        type: 'integer',
        nullable: true,
        description:
          'The price this line is marked down **from**. Null means not on sale — render a struck-through price only when this is present. Never lower than `unitPriceMinor`.',
        example: null,
      },
      stockQty: {
        type: 'integer',
        nullable: true,
        description: "Live supplier stock. Cap a quantity stepper at this value.",
        example: 14,
      },
      priceChanged: {
        type: 'boolean',
        description: 'The price moved since the line was added. Show the new one before checkout.',
        example: false,
      },
      unavailable: {
        type: 'boolean',
        description: 'The title can no longer be bought (out of stock, delisted, or market-restricted).',
        example: false,
      },
      clamped: {
        type: 'boolean',
        description: 'The requested quantity exceeded stock or the per-line cap and was reduced.',
        example: false,
      },
      clampedTo: { type: 'integer', nullable: true, example: null },
    },
  },

  Cart: {
    type: 'object',
    properties: {
      cartId: { type: 'integer', example: 812 },
      currency: {
        type: 'string',
        description:
          'Always `GBP`: prices are passed through exactly as Gardners supplies them. Every `*Minor` field on this response is in pence. A `?currency=` parameter is accepted and ignored.',
        example: 'GBP',
      },
      lines: { type: 'array', items: { $ref: '#/components/schemas/CartLine' } },
      subtotalMinor: { type: 'integer', example: 2598 },
      estimatedShippingMinor: {
        type: 'integer',
        description:
          'An estimate only — the real figure needs a destination country, which is supplied at checkout.',
        example: 899,
      },
      totalMinor: { type: 'integer', example: 3497 },
      itemCount: { type: 'integer', example: 2 },
      hasIssues: {
        type: 'boolean',
        description: 'True when any line has `priceChanged` or `unavailable` set.',
        example: false,
      },
    },
  },

  PricedLine: {
    type: 'object',
    description:
      'One line of a client-held basket, priced by the server. Everything here is computed from our own data — prices sent in the request are ignored.',
    properties: {
      bookId: { type: 'integer', example: 48213 },
      isbn13: { type: 'string', nullable: true, example: '9780241988268' },
      title: { type: 'string', nullable: true, example: 'Girl, Woman, Other' },
      contributor: { type: 'string', nullable: true, example: 'Bernardine Evaristo' },
      coverUrl: { type: 'string', format: 'uri', nullable: true },
      quantity: { type: 'integer', description: 'What was asked for.', example: 3 },
      availableQuantity: {
        type: 'integer',
        description:
          'How many can actually be supplied, capped at `quantity`. Lower than `quantity` means partial stock — show "only N available" and adjust the stepper. This is **not** the supplier stock level and never exceeds what was requested.',
        example: 2,
      },
      unitPriceMinor: { type: 'integer', nullable: true, example: 1299 },
      lineTotalMinor: {
        type: 'integer', nullable: true,
        description: 'Priced on `availableQuantity`, not `quantity`, so the total never includes copies we cannot ship.',
        example: 2598,
      },
      compareAtMinor: {
        type: 'integer', nullable: true,
        description: 'Marked down from this. Null means not on sale.',
        example: null,
      },
      unavailable: { type: 'boolean', example: false },
      unavailableReason: {
        type: 'string', nullable: true,
        enum: ['not_found', 'no_price', 'out_of_stock', 'unsuppliable', 'market_restricted', null],
        example: null,
      },
    },
  },

  PricedBasket: {
    type: 'object',
    description:
      'A client-held basket priced by the server. Nothing is stored — this is a pure read.',
    properties: {
      currency: { type: 'string', example: 'GBP' },
      lines: { type: 'array', items: { $ref: '#/components/schemas/PricedLine' } },
      subtotalMinor: { type: 'integer', description: 'Sellable lines only.', example: 2598 },
      estimatedShippingMinor: {
        type: 'integer', nullable: true,
        description: 'Indicative. Null when the country is unknown — the binding figure is quoted at checkout.',
        example: 399,
      },
      totalMinor: { type: 'integer', example: 2997 },
      itemCount: { type: 'integer', example: 2 },
      hasIssues: {
        type: 'boolean',
        description: 'Some line is unavailable or short on stock. Surface it before checkout.',
        example: false,
      },
    },
  },

  AdminOrder: {
    type: 'object',
    description: 'One row of the admin Orders table. Read-only — the console has no endpoint to change any of it.',
    properties: {
      id: { type: 'integer', example: 1042 },
      reference: { type: 'string', example: 'ORD-7K2M9QX4' },
      status: { type: 'string', description: 'The raw status, one of eleven.', example: 'paid' },
      tab: {
        type: 'string',
        enum: ['processing', 'shipped', 'delivered', 'needs_attention', 'unpaid'],
        description: 'Which admin tab this row belongs to.',
        example: 'processing',
      },
      currency: { type: 'string', example: 'GBP' },
      subtotalMinor: { type: 'integer', example: 7448 },
      discountMinor: { type: 'integer', example: 1117 },
      shippingMinor: { type: 'integer', example: 0 },
      taxMinor: { type: 'integer', example: 0 },
      totalMinor: { type: 'integer', example: 6331 },
      itemCount: { type: 'integer', example: 3 },
      placedAt: { type: 'string', format: 'date-time' },
      paidAt: { type: 'string', format: 'date-time', nullable: true },
      customerId: { type: 'integer', nullable: true, description: 'Null for a guest order.', example: null },
      customerName: { type: 'string', nullable: true, description: 'Account name, falling back to the name on the parcel.', example: 'Jane Doe' },
      contactEmail: { type: 'string', format: 'email' },
      contactPhone: { type: 'string', nullable: true, example: '+233201234567' },
      shippingName: { type: 'string', nullable: true },
      shippingLine1: { type: 'string', nullable: true },
      shippingLine2: { type: 'string', nullable: true },
      shippingCity: { type: 'string', nullable: true },
      shippingPostcode: { type: 'string', nullable: true },
      shippingCountryCode: { type: 'string', example: 'GH' },
      fulfilmentError: {
        type: 'string', nullable: true,
        description: 'Why the supplier rejected it. Populated on needs_attention rows and null otherwise — this is the field that makes a stuck paid order diagnosable.',
        example: null,
      },
      items: {
        type: 'array',
        description: 'Present only with ?withItems=true.',
        items: {
          type: 'object',
          properties: {
            bookId: { type: 'integer' },
            isbn13: { type: 'string' },
            title: { type: 'string' },
            contributor: { type: 'string', nullable: true },
            quantity: { type: 'integer' },
            unitPriceMinor: { type: 'integer' },
            lineTotalMinor: { type: 'integer' },
          },
        },
      },
    },
  },

  AdminCustomer: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 4412 },
      name: { type: 'string', example: 'Amara Diallo' },
      email: { type: 'string', format: 'email' },
      countryCode: { type: 'string', nullable: true, description: 'Frozen at signup, not re-resolved on later logins.', example: 'GH' },
      joinedAt: { type: 'string', format: 'date-time' },
      orders: { type: 'integer', description: 'Paid orders only.', example: 4 },
      totalSpentMinor: { type: 'integer', description: 'Lifetime paid total, minor units.', example: 18750 },
      lastOrderAt: { type: 'string', format: 'date-time', nullable: true },
      lastSignInAt: {
        type: 'string',
        format: 'date-time',
        description: 'Last seen on an authenticated request, not just last password entry. Updated at most once a day. Accounts predating this field were seeded from their signup date.',
      },
      active: { type: 'boolean', description: 'Seen in the last 12 months.', example: true },
      isGuest: {
        type: 'boolean',
        description: 'Account created by the web shop for a browser rather than by a person signing up. Only guests who completed a purchase appear here at all.',
        example: false,
      },
      blacklisted: { type: 'boolean', example: false },
      blacklistedAt: { type: 'string', format: 'date-time', nullable: true },
      blacklistReason: { type: 'string', nullable: true },
    },
  },

  AdminReport: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 3 },
      reference: { type: 'string', nullable: true, description: 'What the screen displays, e.g. R003.', example: 'R003' },
      status: { type: 'string', enum: ['pending', 'resolved', 'dismissed'], example: 'pending' },
      reason: { type: 'string', example: 'Created multiple accounts to abuse the first-order discount.' },
      postId: { type: 'integer', nullable: true, description: 'The post complained about, when there was one. Nulled if that post is later deleted — the report survives it.' },
      targetType: { type: 'string', enum: ['user', 'group'], description: 'What this report is filed against. Exactly one of `reportedUser` / `reportedGroup` is populated.', example: 'user' },
      targetName: { type: 'string', nullable: true, description: 'The reported user\'s name, or the reported group\'s — whichever this report is about. Lets a row be rendered without branching on `targetType`. Null only if a reported group has since been deleted.', example: 'Kwame Asante' },
      filedAt: { type: 'string', format: 'date-time' },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      reportedUser: {
        type: 'object',
        nullable: true,
        description: 'Null on a group report.',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          blacklisted: { type: 'boolean' },
        },
      },
      reportedGroup: {
        type: 'object',
        nullable: true,
        description: 'Null on a user report, and also null once a reported group has been deleted — the complaint outlives its target.',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      },
      reportedBy: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
        },
      },
    },
  },

  AdminBanner: {
    type: 'object',
    properties: {
      slot: { type: 'string', enum: ['top', 'second'], example: 'top' },
      enabled: { type: 'boolean', example: true },
      text: { type: 'string', maxLength: 200, example: 'We Ship Worldwide!' },
      updatedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  AdminNotification: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 12 },
      type: {
        type: 'string',
        enum: ['report_filed', 'order_received', 'customer_registered', 'order_delivered'],
        description: 'order_delivered never fires yet — nothing marks an order delivered until there is a courier signal.',
        example: 'order_received',
      },
      title: { type: 'string', example: 'New order received' },
      body: { type: 'string', example: 'ORD-7K2M9QX4 — $63.31 from ama@example.com.' },
      orderId: { type: 'integer', nullable: true },
      userId: { type: 'integer', nullable: true },
      reportId: { type: 'integer', nullable: true },
      read: { type: 'boolean', description: 'Shared across admins, not per-person.', example: false },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Order: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 1042 },
      reference: {
        type: 'string',
        description:
          'The customer-facing order identity — the order number. This is what to print on receipts, quote in support, and ask for on the tracking form. Random, not sequential. **It is an identifier, not a credential**: `POST /orders/track` also requires the contact email, and `POST /orders/lookup` the access token from checkout.',
        example: 'ORD-7K2M9QX4',
      },
      trackingCode: {
        type: 'string',
        deprecated: true,
        description:
          '**Deprecated and not customer-facing.** An internal short code kept on the order for continuity; no endpoint accepts it and it appears in no email. Track an order with `reference` plus the contact email. For the carrier\u2019s number see `trackingNumber`.',
        example: '7K2M9QX4',
      },
      status: {
        type: 'string',
        enum: [
          'pending_payment', 'payment_failed', 'expired', 'paid',
          'submitted_to_supplier', 'acknowledged', 'supplier_rejected',
          'dispatched', 'delivered', 'refunded', 'cancelled',
        ],
        description:
          'The precise internal state. Prefer `statusBucket` for UI — it is stable, while new values may be added here. `GET /orders` never lists orders abandoned before payment.',
        example: 'paid',
      },
      statusBucket: {
        type: 'string',
        enum: ['pending', 'in_progress', 'delivered', 'closed'],
        description:
          'The status collapsed for display, and what the order filter tabs map to. `in_progress` covers everything from payment to dispatch; `closed` covers refunded, cancelled and supplier-rejected. Bucket on this rather than on `status`.',
        example: 'in_progress',
      },
      carrier: { type: 'string', nullable: true, example: 'Royal Mail' },
      trackingNumber: { type: 'string', nullable: true, example: 'AB123456789GB' },
      trackingUrl: {
        type: 'string', format: 'uri', nullable: true,
        description: 'Ready-made link for a "Track parcel" button. Null until the parcel ships — all four tracking fields stay null while the order is being prepared, which is normal, not an error.',
        example: null,
      },
      dispatchedAt: { type: 'string', format: 'date-time', nullable: true, example: null },
      deliveredAt: { type: 'string', format: 'date-time', nullable: true, example: null },
      currency: { type: 'string', example: 'GBP' },
      subtotalMinor: { type: 'integer', example: 2598 },
      discountMinor: {
        type: 'integer',
        description: 'Promotional reduction applied at checkout, 0 when none. The components always reconcile: `subtotalMinor - discountMinor + shippingMinor + taxMinor === totalMinor`.',
        example: 0,
      },
      discountReason: {
        type: 'string', nullable: true,
        description: 'Why it was given — `first_order` is the only value today. Null when there was no discount.',
        example: null,
      },
      shippingMinor: { type: 'integer', example: 899 },
      taxMinor: {
        type: 'integer',
        description:
          'Physical books are zero-rated in the UK and Ireland, so 0 here is usually correct rather than missing.',
        example: 0,
      },
      totalMinor: { type: 'integer', example: 3497 },
      itemCount: { type: 'integer', example: 2 },
      shippingCountryCode: { type: 'string', example: 'US' },
      contactPhone: {
        type: 'string', nullable: true,
        description: 'The delivery contact the order was placed with, E.164. Snapshotted at checkout, so editing the profile number later does not change it.',
        example: '+233201234567',
      },
      placedAt: { type: 'string', format: 'date-time', example: '2026-08-01T12:00:00.000Z' },
      paidAt: { type: 'string', format: 'date-time', nullable: true, example: '2026-08-01T12:01:14.000Z' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            bookId: { type: 'integer', example: 48213 },
            title: { type: 'string', example: 'Girl, Woman, Other' },
            isbn13: { type: 'string', nullable: true, example: '9780241988268' },
            coverUrl: { type: 'string', format: 'uri', nullable: true },
            quantity: { type: 'integer', example: 2 },
            unitPriceMinor: { type: 'integer', example: 1299 },
            lineTotalMinor: { type: 'integer', example: 2598 },
          },
        },
      },
    },
  },

  Subscription: {
    type: 'object',
    description:
      'The single source of truth for the paywall. Note the trial is ours, not Stripe’s: a `trialing` user has no Stripe subscription and therefore nothing to cancel.',
    properties: {
      tier: { type: 'string', enum: ['free', 'plus'], example: 'plus' },
      status: {
        type: 'string',
        enum: ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'free'],
        example: 'active',
      },
      plan: {
        type: 'string',
        nullable: true,
        enum: ['monthly', 'annual', null],
        description: 'Null while free or trialing — there is no purchased plan yet.',
        example: 'annual',
      },
      provider: {
        type: 'string',
        nullable: true,
        enum: ['stripe', 'apple', null],
        description:
          'Who bills the current (or most recent) paid subscription; null if they have never paid. With `apple`, hide the cancel / change / reactivate buttons — those return 409 `MANAGED_BY_APPLE` — and link to https://apps.apple.com/account/subscriptions instead. With `stripe` and an active subscription, do not offer an App Store purchase.',
        example: 'stripe',
      },
      pendingPlan: {
        type: 'string',
        nullable: true,
        enum: ['monthly', 'annual', null],
        description: 'A plan switch already scheduled for `currentPeriodEnd`.',
        example: null,
      },
      trialEndsAt: { type: 'string', format: 'date-time', nullable: true, example: null },
      trialDaysLeft: { type: 'integer', nullable: true, example: null },
      currentPeriodEnd: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Paid through this date; renews automatically unless `cancelAtPeriodEnd`.',
        example: '2027-03-01T00:00:00.000Z',
      },
      cancelAtPeriodEnd: { type: 'boolean', example: false },
      isFoundingMember: {
        type: 'boolean',
        description: 'Locked in at the launch price. Lost if they cancel and resubscribe later.',
        example: true,
      },
      hasBillingAccount: { type: 'boolean', example: true },
      foundingOfferActive: {
        type: 'boolean',
        description: 'Whether the launch window is still open for *new* subscribers.',
        example: false,
      },
      paymentsAvailable: {
        type: 'boolean',
        description:
          'False when Stripe is not configured on this deployment. Hide the upgrade button rather than letting it 503.',
        example: true,
      },
      appleIapAvailable: {
        type: 'boolean',
        description:
          'False when App Store purchases are not configured on this deployment. The iOS app should hide its purchase button rather than letting verify 503.',
        example: true,
      },
      appleAppAccountToken: {
        type: 'string',
        format: 'uuid',
        description:
          'Pass as `appAccountToken` when starting an App Store purchase. Stable per account. Lets `/apple/verify` refuse a purchase made while signed in to a different Kinkané account.',
        example: '3f1c2a9e-7b4d-4e2a-9c1f-5d6e7f8a9b0c',
      },
    },
  },
} as const;

const miscSchemas = {
  AuthSuccess: {
    type: 'object',
    description: 'Returned by every endpoint that establishes a session.',
    properties: {
      user: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 4412 },
          name: { type: 'string', example: 'Ama Boateng' },
          username: {
            type: 'string', nullable: true,
            description: 'The @handle — the one chosen at signup, or one generated from the name. Null only for web-shop guest accounts.',
            example: 'ama_reads',
          },
          email: { type: 'string', format: 'email', example: 'ama@example.com' },
          emailVerified: { type: 'boolean', example: false },
        },
      },
      accessToken: {
        type: 'string',
        description: 'Short-lived JWT. Send as `Authorization: Bearer <token>`.',
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjQ0MTIsImVtYWlsIjoiYW1hQGV4YW1wbGUuY29tIn0.PLACEHOLDER',
      },
      refreshToken: {
        type: 'string',
        description: 'Single-use. Store it; the next refresh returns a replacement.',
        example: 'b7f3a1c2-9d84-4e17-9c55-2f0a6d3e8b41',
      },
    },
  },

  Pagination: {
    type: 'object',
    description:
      'Offset pagination, echoed back on list responses. Note `GET /books?dedupe=true` uses cursor pagination instead — see that endpoint.',
    properties: {
      total: { type: 'integer', example: 137 },
      limit: { type: 'integer', example: 20 },
      offset: { type: 'integer', example: 0 },
      hasMore: { type: 'boolean', example: true },
    },
  },

  ReadingPreferences: {
    type: 'object',
    description: 'The taste profile captured by the onboarding quiz.',
    properties: {
      feelings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exactly 3. Preset labels or freeform, each ≤200 characters.',
        example: ['hopeful', 'a bit unsettled', 'ready to think'],
      },
      genres: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exactly 3, from the fixed genre list.',
        example: ['literary fiction', 'historical fiction', 'poetry'],
      },
      dislikes: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description:
          'Reading experiences to avoid, grouped by whatever category keys the onboarding UI uses. Deliberately open — neither keys nor labels are validated against a fixed list, so copy changes need no backend release. Labels cap at 200 characters. Two labels additionally apply hard SQL filters wherever they appear: `long book (500+ pages)` and `series commitment`.',
        example: {
          emotionalTone: ['bleak endings'],
          commitmentLevel: ['long book (500+ pages)'],
        },
      },
      bookIds: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Up to 10 books they told us they already enjoyed.',
        example: [48213, 51002],
      },
      dislikedBookIds: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Read-only, and cumulative across every quiz they have ever taken. Books here are filtered out of quiz results, the personalised feed, "you may also like", and recommendation emails — permanently.',
        example: [12045, 12046, 33871],
      },
    },
  },

  Recommendation: {
    type: 'object',
    properties: {
      bookId: { type: 'integer', example: 48213 },
      rank: { type: 'integer', description: '1 is the strongest match.', example: 1 },
      explanation: {
        type: 'string',
        description: 'A ≤120-character reason, generated per book by Gemini.',
        example: 'Polyphonic and hopeful, with the historical sweep you asked for.',
      },
      myReview: {
        allOf: [{ $ref: '#/components/schemas/MyReview' }],
        description: 'Present on `PATCH /recommendations/refresh` only — the guest quiz has no reviews to show.',
      },
    },
  },

  NotificationPreferences: {
    type: 'object',
    description:
      'All flags default to true at account creation. `comments` and `likes` govern push and the in-app feed only — social activity never sends email whatever these say.',
    properties: {
      marketingEmails: { type: 'boolean', example: true },
      newBookSuggestions: { type: 'boolean', example: true },
      rateReviewReminders: { type: 'boolean', example: true },
      friendRequests: { type: 'boolean', example: true },
      comments: { type: 'boolean', example: true },
      likes: { type: 'boolean', example: true },
      groupInvites: { type: 'boolean', example: true },
      mentions: { type: 'boolean', example: true, description: 'Someone @-mentioned you. Push and the in-app feed only.' },
    },
  },
} as const;

export const schemas = {
  ...errorSchemas,
  ...bookSchemas,
  ...socialSchemas,
  ...commerceSchemas,
  ...miscSchemas,
} as const;

// ── Reusable responses ────────────────────────────────────────────────────────

function errorResponse(description: string, schemaRef = 'Error', example?: unknown) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
        ...(example === undefined ? {} : { example }),
      },
    },
  };
}

export const responses = {
  ValidationError: errorResponse(
    'Request validation failed. `error` is an object of field → messages.',
    'ValidationError',
  ),
  Unauthorized: errorResponse(
    'Missing, malformed or expired access token. Refresh it and retry.',
    'Error',
    { error: 'Missing or malformed Authorization header' },
  ),
  PlusRequired: errorResponse(
    'Kinkané Plus is required. See the `PlusRequired` schema — branch on `code`, not the message.',
    'PlusRequired',
  ),
  Forbidden: errorResponse('The caller is authenticated but not allowed to do this.', 'Error', {
    error: 'You do not have access to this shelf',
  }),
  NotFound: errorResponse(
    'No such resource, **or** it exists but does not belong to the caller — the two are deliberately indistinguishable so this endpoint cannot be used to probe for other people’s data.',
    'Error',
    { error: 'Not found' },
  ),
  Conflict: errorResponse(
    'The request was valid but conflicts with current state. `code` says which conflict.',
    'Error',
  ),
  RateLimited: errorResponse(
    'Rate limit exceeded. `RateLimit-Reset` on the response says how many seconds until the window rolls over.',
    'Error',
    { error: 'Too many requests — please try again later' },
  ),
  PaymentsUnavailable: errorResponse(
    'Stripe is not configured on this deployment. Check `paymentsAvailable` on the subscription object and hide purchase UI rather than calling this.',
    'Error',
    { error: 'Payments are not configured' },
  ),
  ServerError: errorResponse('Unexpected server error.', 'Error', {
    error: 'Internal server error',
  }),
} as const;
