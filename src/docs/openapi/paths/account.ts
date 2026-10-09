import {
  ref, resp, json, body, object, param, arrayOf, authErrors, successResponse, publicEndpoint,
} from '../helpers';

const TAG = 'Account & Settings';
const NOTIF = 'Notifications';

export const accountPaths = {
  '/api/v1/user/settings': {
    get: {
      tags: [TAG],
      summary: 'Get account settings',
      description:
        'The caller’s profile basics, shelf visibility and reader type. Notification toggles live under `/user/notification-preferences`.',
      responses: {
        200: json('The settings.',
          object({
            settings: object({
              name: { type: 'string', example: 'Ada' },
              username: { type: 'string', nullable: true, example: 'ada.reads' },
              usernameChangedAt: {
                type: 'string', format: 'date-time', nullable: true,
                description: 'When the user last chose a username. Null if they never have — a generated name can be replaced straight away.',
              },
              nextUsernameChangeAt: {
                type: 'string', format: 'date-time', nullable: true,
                description: 'When the username may next be changed. Null when it can be changed now.',
              },
              photoUrl: { type: 'string', format: 'uri', nullable: true },
              shelfVisibility: { type: 'string', enum: ['public', 'friends', 'private'], example: 'friends' },
              readerType: {
                type: 'string', nullable: true,
                description: 'Set at signup and re-inferred on each quiz retake. `null` if it was never inferred.',
                example: 'The Open Door',
              },
              readerTypeTagline: {
                type: 'string', nullable: true,
                description: 'One-line tagline for `readerType`, for display under it. `null` whenever `readerType` is.',
                example: "You're open to the world but discerning about what stays.",
              },
            }),
          })),
        401: resp('Unauthorized'),
        404: resp('NotFound'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/settings/username': {
    patch: {
      tags: [TAG],
      summary: 'Change your @username',
      description: [
        'Normalized like signup (trimmed, leading `@` dropped, lowercased), then the same rules: 3–20 characters of `a-z 0-9 _ .`, not starting or ending with a dot, no `..`, not reserved.',
        '',
        '**Once every 30 days.** The first change after signup is always allowed — a generated username was never chosen. The name given up is **held for you for 30 days**: nobody else can take it, and you can take it back.',
        '',
        '**Taking it back is an undo**, allowed even inside the 30 days. It does not restart the cooldown, and the name you step off is held only until the original hold would have run out.',
        '',
        'Existing mentions follow you — they are stored by account id and read as the new name from the next request.',
      ].join('\n'),
      requestBody: body(object({ username: { type: 'string', example: 'ada.reads' } }, ['username'])),
      responses: {
        200: json('Changed.', object({
          username: { type: 'string', example: 'ada.reads' },
          usernameChangedAt: { type: 'string', format: 'date-time' },
          nextChangeAt: { type: 'string', format: 'date-time', description: 'The earliest the next change may happen.' },
        })),
        400: resp('ValidationError'),
        409: json('`USERNAME_TAKEN` (someone has it, or is holding it), or `USERNAME_UNCHANGED` (it is already yours).', ref('Error'),
          { error: 'That username is taken', code: 'USERNAME_TAKEN' }),
        422: json('`USERNAME_INVALID` or `USERNAME_RESERVED`.', ref('Error'),
          { error: 'That username is reserved', code: 'USERNAME_RESERVED' }),
        429: json('`USERNAME_CHANGE_TOO_SOON` — changed within the last 30 days. `nextChangeAt` says when it is allowed. (Also the generic rate limit.)', ref('Error'),
          { error: 'You changed your username recently — try again later', code: 'USERNAME_CHANGE_TOO_SOON', nextChangeAt: '2026-11-08T18:04:55.608Z' }),
        401: resp('Unauthorized'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/mentions': {
    get: {
      tags: [NOTIF],
      summary: 'Where you have been @-mentioned',
      description:
        'Every mention of the caller that has been delivered, newest first, across posts, comments, groups, group discussions and shelf notes.\n\nVisibility is re-checked on every read: an entry whose text the caller can no longer see (a private group they are not in, a post since made private) keeps its place with `restricted: true` and no excerpt, so pages never shift under the client. Mentions in a private post or note are not listed until it is made public. Self-mentions are never listed.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of mentions.', object({
          mentions: arrayOf(ref('MentionFeedItem')),
          total: { type: 'integer', example: 12 },
          limit: { type: 'integer', example: 20 },
          offset: { type: 'integer', example: 0 },
        })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/settings/profile': {
    patch: {
      tags: [TAG],
      summary: 'Update name, profile photo and phone',
      description: [
        'Patch semantics — send only what changes.',
        '',
        '**`photoUrl` must already be hosted on Kinkané’s own Cloudinary account.** This endpoint does not accept uploads: upload to Cloudinary from the client first, then send the resulting URL here. URLs on any other host — including other Cloudinary accounts — are rejected with a 400, so an arbitrary third-party image cannot be made to render as a user’s avatar.',
        '',
        'Pass `photoUrl: null` to remove the photo, or `phone: null` to remove the number.',
      ].join('\n'),
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 100, example: 'Ama Boateng' },
        photoUrl: {
          type: 'string', format: 'uri', nullable: true,
          description: 'Must be on `res.cloudinary.com` under the configured cloud name. `null` clears it.',
          example: 'https://res.cloudinary.com/kinkane/image/upload/v1/avatars/4412.jpg',
        },
        phone: {
          type: 'string', maxLength: 32, nullable: true,
          description: 'International format (`+233…` or `00233…`); spaces, dashes and brackets are stripped and it is stored E.164. A bare national number is rejected — the country code is not guessed. `null` clears it.',
          example: '+233201234567',
        },
      })),
      responses: {
        200: json('Updated.',
          object({
            name: { type: 'string', example: 'Ama Boateng' },
            photoUrl: { type: 'string', format: 'uri', nullable: true },
            phone: { type: 'string', nullable: true, example: '+233201234567' },
          })),
        400: json('Validation failed, or the photo URL is not on the expected Cloudinary account.',
          ref('ValidationError')),
        401: resp('Unauthorized'),
        404: resp('NotFound'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/settings/shelf-visibility': {
    patch: {
      tags: [TAG],
      summary: 'Set who can see the shelf',
      description: [
        'Controls who may read this user’s reading list:',
        '',
        '- `public` — any signed-in Kinkané user.',
        '- `friends` — accepted mutual followers only.',
        '- `private` — nobody but the owner.',
        '',
        'This is what `canViewShelf` on a profile resolves against, and what makes `GET /users/{userId}/books` return 403.',
      ].join('\n'),
      requestBody: body(object({
        visibility: { type: 'string', enum: ['public', 'friends', 'private'], example: 'friends' },
      }, ['visibility'])),
      responses: {
        200: json('Updated.',
          object({ shelfVisibility: { type: 'string', enum: ['public', 'friends', 'private'], example: 'friends' } })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  // ── Notification preferences ───────────────────────────────────────────────

  '/api/v1/user/notification-preferences': {
    get: {
      tags: [NOTIF],
      summary: 'Get notification preferences',
      description: 'All eight toggles. Every one defaults to true at account creation.',
      responses: {
        200: json('The preferences.',
          object({ notificationPreferences: ref('NotificationPreferences') })),
        ...authErrors,
      },
    },

    patch: {
      tags: [NOTIF],
      summary: 'Update notification preferences',
      description:
        'Patch semantics — omitted flags are left alone.\n\n`comments` and `likes` govern **push and the in-app feed only**. Social activity never sends email regardless of what they are set to, so switching them off does not silence an email the user is seeing.',
      requestBody: body(object({
        marketingEmails: { type: 'boolean', example: false },
        newBookSuggestions: { type: 'boolean', example: true },
        rateReviewReminders: { type: 'boolean', example: true },
        friendRequests: { type: 'boolean', example: true },
        comments: { type: 'boolean', example: true },
        likes: { type: 'boolean', example: false },
        groupInvites: { type: 'boolean', example: true },
        mentions: { type: 'boolean', example: true },
      })),
      responses: {
        200: json('Updated.', object({ notificationPreferences: ref('NotificationPreferences') })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/notifications': {
    get: {
      tags: [NOTIF],
      summary: 'The notifications feed',
      description:
        'The caller’s notifications, newest first. Marking an item read keeps it in the feed; it stays until it is cleared.',
      parameters: [
        param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Items per page (1–50).'),
        param('offset', 'query', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip.'),
      ],
      responses: {
        200: json('A page of notifications.',
          object({
            notifications: arrayOf(ref('Notification')),
            total: { type: 'integer', example: 41 },
            unreadCount: {
              type: 'integer',
              description: 'Notifications not yet marked read, across the whole feed — use it for the badge.',
              example: 3,
            },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
    delete: {
      tags: [NOTIF],
      summary: 'Clear all notifications',
      description:
        'Removes every notification in the caller’s feed, read or unread, except friend requests still waiting on an answer — those stay until accepted or declined.',
      responses: {
        200: json('Cleared.', object({ cleared: { type: 'integer', description: 'How many were removed.', example: 12 } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/notifications/read': {
    patch: {
      tags: [NOTIF],
      summary: 'Mark notifications as read',
      description:
        'Marks the given notifications read. They stay in the feed until cleared. Ids that aren’t the caller’s are ignored.',
      requestBody: body(object({
        ids: {
          type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 50,
          description: 'Between 1 and 50 notification ids.',
          example: [5521, 5522],
        },
      }, ['ids'])),
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/notifications/{id}': {
    delete: {
      tags: [NOTIF],
      summary: 'Clear one notification',
      description:
        'Removes the notification from the feed, read or unread. A friend request still waiting on an answer can’t be cleared: accept or decline it first.',
      parameters: [param('id', 'path', { type: 'integer', minimum: 1 }, 'The notification id.')],
      responses: {
        200: json('Cleared.', object({ cleared: { type: 'integer', example: 1 } })),
        400: resp('ValidationError'),
        404: resp('NotFound'),
        409: json('A friend request still waiting on an answer (`code: FRIEND_REQUEST_PENDING`).', ref('Error')),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/device-tokens': {
    post: {
      tags: [NOTIF],
      summary: 'Register a device for push',
      description:
        'Registers an FCM token against the caller. Call it on every sign-in **and** whenever the client’s token refreshes — FCM rotates them.\n\nIf the token was previously registered to a different account it is reassigned to this one, which is what makes shared devices behave.',
      requestBody: body(object({
        fcmToken: { type: 'string', minLength: 1, maxLength: 4096, example: 'fMEp9…:APA91bH…' },
        platform: { type: 'string', enum: ['ios', 'android'], example: 'ios' },
      }, ['fcmToken', 'platform'])),
      responses: {
        200: successResponse,
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/device-tokens/{fcmToken}': {
    delete: {
      tags: [NOTIF],
      summary: 'Unregister a device',
      description:
        'Call on sign-out so the device stops receiving this user’s push. Scoped to the caller — a token registered to another account returns 404 rather than being deleted.',
      parameters: [
        param('fcmToken', 'path', { type: 'string', maxLength: 4096 },
          'The token to remove. URL-encode it — FCM tokens contain `:` and `/`.',
          { example: 'fMEp9…:APA91bH…' }),
      ],
      responses: {
        200: successResponse,
        404: json('No such token registered to this account.', ref('Error'), { error: 'Token not found' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/unsubscribe': {
    get: {
      tags: [NOTIF],
      ...publicEndpoint,
      summary: 'One-click unsubscribe from promotional email',
      description: [
        '**Returns an HTML page, not JSON.** This URL is opened in a browser from an email client’s footer; the app never calls it.',
        '',
        'Unauthenticated — the HMAC-signed token *is* the proof of identity.',
        '',
        'Scoped to promotional mail only: the newsletter, book recommendations and reading reminders. Follow requests and anything about the account, subscription or security keep sending, because those are either something another person did or something the user needs to see. Only emails in the promotional set carry this link in the first place, so it never appears on mail it could not actually stop.',
        '',
        'An address with no account still gets the success page — this cannot be used to test whether an address is registered.',
      ].join('\n'),
      parameters: [
        param('token', 'query', { type: 'string' },
          'The signed token from the email footer.', { required: true, example: 'eyJhbGciOiJIUzI1NiJ9…' }),
      ],
      responses: {
        200: {
          description: 'An HTML confirmation page.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
        400: {
          description: 'An HTML error page — the token is missing, malformed or expired.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
        500: {
          description: 'An HTML error page.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
      },
    },
  },
};
