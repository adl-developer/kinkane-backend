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
        example: 'https://kinkane.app/account/subscription',
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
      name: { type: 'string', example: 'Literary Fiction' },
      slug: { type: 'string', example: 'literary-fiction' },
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
      genres: { type: 'array', items: { $ref: '#/components/schemas/Genre' } },
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
        description: 'ISO-4217 for the two fields above. Resolved from the request, or the `currency` parameter.',
        example: 'USD',
      },
      inStock: {
        type: 'boolean',
        example: true,
        description:
          'Present only on `GET /books?shoppable=true`. Whether the supplier currently has stock. `false` means list it with an out-of-stock badge, not hide it. Absent on every other endpoint — do not treat a missing value as out of stock.',
      },
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
          userStatus: {
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
        },
      },
    ],
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
    },
  },
} as const;

const socialSchemas = {
  UserSummary: {
    type: 'object',
    description: 'The public face of an account, as it appears in lists and on posts.',
    properties: {
      id: { type: 'integer', example: 4412 },
      name: { type: 'string', example: 'Ama Boateng' },
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
      rating: { type: 'integer', minimum: 1, maximum: 5, example: 5 },
      status: {
        type: 'string',
        enum: ['reading', 'read'],
        description: 'Where the author was in the book when they posted.',
        example: 'read',
      },
      body: {
        type: 'string',
        nullable: true,
        description: 'The review text. Optional — a rating on its own is a valid post.',
        example: 'Twelve voices and not one wasted page.',
      },
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

  Comment: {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 771 },
      postId: { type: 'integer', example: 3310 },
      author: { $ref: '#/components/schemas/UserSummary' },
      body: { type: 'string', example: 'Adding it to my list right now.' },
      likeCount: { type: 'integer', example: 2 },
      likedByMe: { type: 'boolean', example: false },
      createdAt: { type: 'string', format: 'date-time', example: '2026-07-30T21:10:00.000Z' },
    },
  },

  Notification: {
    type: 'object',
    description:
      'One item in the notifications feed. The feed merges stored rows (`post_like`, `post_comment`) with a live view over the follow-request table, which is why `id` is only markable-as-read for the stored kinds.',
    properties: {
      id: { type: 'integer', example: 5521 },
      type: {
        type: 'string',
        enum: ['post_like', 'post_comment', 'friend_request'],
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
          'Resolved from the caller’s country, overridable with `?currency=`. Every `*Minor` field on this response is in this currency.',
        example: 'USD',
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
      currency: { type: 'string', example: 'USD' },
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
      active: { type: 'boolean', description: 'Paid for something in the last 12 months.', example: true },
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
      filedAt: { type: 'string', format: 'date-time' },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      reportedUser: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          blacklisted: { type: 'boolean' },
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
          'The customer-facing order identity — this is what to print on receipts and quote in support. Random, not sequential. **It is an identifier, not a credential**: reading a guest order also requires the access token from checkout.',
        example: 'ORD-7K2M9QX4',
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
      currency: { type: 'string', example: 'USD' },
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
