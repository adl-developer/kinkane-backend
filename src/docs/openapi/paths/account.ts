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
        'The caller’s settings. Currently just shelf visibility; notification toggles live under `/user/notification-preferences`.',
      responses: {
        200: json('The settings.',
          object({
            settings: object({
              shelfVisibility: { type: 'string', enum: ['public', 'friends', 'private'], example: 'friends' },
            }),
          })),
        401: resp('Unauthorized'),
        404: resp('NotFound'),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/user/settings/profile': {
    patch: {
      tags: [TAG],
      summary: 'Update name and profile photo',
      description: [
        'Patch semantics — send only what changes.',
        '',
        '**`photoUrl` must already be hosted on Kinkané’s own Cloudinary account.** This endpoint does not accept uploads: upload to Cloudinary from the client first, then send the resulting URL here. URLs on any other host — including other Cloudinary accounts — are rejected with a 400, so an arbitrary third-party image cannot be made to render as a user’s avatar.',
        '',
        'Pass `photoUrl: null` to remove the photo.',
      ].join('\n'),
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 100, example: 'Ama Boateng' },
        photoUrl: {
          type: 'string', format: 'uri', nullable: true,
          description: 'Must be on `res.cloudinary.com` under the configured cloud name. `null` clears it.',
          example: 'https://res.cloudinary.com/kinkane/image/upload/v1/avatars/4412.jpg',
        },
      })),
      responses: {
        200: json('Updated.',
          object({
            name: { type: 'string', example: 'Ama Boateng' },
            photoUrl: { type: 'string', format: 'uri', nullable: true },
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
      description: 'All six toggles. Every one defaults to true at account creation.',
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
        'Merges stored notifications (post likes, post comments) with a live view over pending and resolved follow requests, newest first.\n\nBecause friend-request items are computed rather than stored, they cannot be marked read here — resolving them means accepting or declining the request.',
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
              description: 'Across the whole feed, not just this page — use it for the badge.',
              example: 3,
            },
            limit: { type: 'integer', example: 20 },
            offset: { type: 'integer', example: 0 },
          })),
        400: resp('ValidationError'),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/notifications/read': {
    patch: {
      tags: [NOTIF],
      summary: 'Mark notifications as read',
      description:
        'Applies to stored notifications only (`post_like`, `post_comment`). Ids belonging to friend-request items are ignored — accept or decline those instead.',
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
